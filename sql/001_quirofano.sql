begin;

create table if not exists public.quirofano_products (
  id text primary key,
  code text not null unique,
  name text not null,
  category text not null default '',
  active boolean not null,
  tax_rate numeric not null,
  tax_error text,
  purchase_cost numeric,
  cost_date date,
  payload jsonb not null,
  synced_at timestamptz not null default now()
);

create table if not exists public.quirofano_catalogs (
  id text primary key check (id in ('taxes', 'price_lists')),
  data jsonb not null,
  synced_at timestamptz not null default now()
);

create table if not exists public.quirofano_liquidations (
  id uuid primary key default gen_random_uuid(),
  product_id text not null references public.quirofano_products(id),
  product_code text not null,
  product_name text not null,
  list_position integer not null check (list_position between 1 and 12),
  params jsonb not null,
  calculation jsonb not null,
  fingerprint text not null,
  cost_source text not null check (cost_source in ('manual', 'purchase')),
  cost_date date,
  status text not null default 'draft' check (status in ('draft', 'applying', 'applied', 'review', 'conflict')),
  previous_value numeric not null check (previous_value >= 0),
  proposed_value numeric not null check (proposed_value > 0),
  created_by uuid not null,
  approved_by uuid,
  created_at timestamptz not null default now(),
  approved_at timestamptz,
  verified_at timestamptz,
  error text
);
create index if not exists quirofano_liquidations_created on public.quirofano_liquidations(created_at desc);
create index if not exists quirofano_liquidations_product on public.quirofano_liquidations(product_id);

create table if not exists public.quirofano_price_events (
  id uuid primary key default gen_random_uuid(),
  liquidation_id uuid not null references public.quirofano_liquidations(id),
  actor uuid not null,
  event text not null,
  detail jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create table if not exists public.quirofano_product_locks (
  product_id text primary key references public.quirofano_products(id),
  liquidation_id uuid not null unique references public.quirofano_liquidations(id),
  acquired_at timestamptz not null default now()
);

create table if not exists public.quirofano_purchase_sources (
  id uuid primary key,
  tax_included boolean not null,
  registered_by uuid not null,
  registered_at timestamptz not null default now(),
  checked_at timestamptz,
  next_check_at timestamptz not null default now(),
  error text
);

create table if not exists public.quirofano_purchase_invoices (
  id uuid primary key references public.quirofano_purchase_sources(id),
  purchase_date date not null,
  supplier text not null,
  total numeric not null,
  synced_at timestamptz not null default now()
);

create table if not exists public.quirofano_purchase_lines (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references public.quirofano_purchase_invoices(id) on delete cascade,
  line_number integer not null,
  code text not null,
  description text not null,
  quantity numeric not null check (quantity > 0),
  unit_cost numeric not null check (unit_cost > 0),
  net_total numeric not null check (net_total > 0),
  supplier text not null,
  supplier_name text not null default '',
  purchase_date date not null,
  unique(invoice_id, line_number)
);
create index if not exists quirofano_purchase_cost_history on public.quirofano_purchase_lines(code, purchase_date);
create index if not exists quirofano_purchase_dates on public.quirofano_purchase_lines(purchase_date);

create table if not exists public.quirofano_daily_summary (
  id date primary key,
  invoices integer not null,
  lines integer not null,
  net_total numeric not null,
  refreshed_at timestamptz not null default now()
);

create table if not exists public.quirofano_sync_locks (
  id text primary key,
  owner uuid not null,
  expires_at timestamptz not null
);

create or replace function public.quirofano_save_liquidations(p_rows jsonb, p_actor uuid)
returns jsonb language plpgsql set search_path = public as $$
declare item jsonb; inserted public.quirofano_liquidations; ids jsonb := '[]';
begin
  if jsonb_array_length(p_rows) not between 1 and 100 then raise exception 'QF_STATE: batch size'; end if;
  for item in select value from jsonb_array_elements(p_rows) loop
    insert into quirofano_liquidations(product_id,product_code,product_name,list_position,params,calculation,
      fingerprint,cost_source,cost_date,previous_value,proposed_value,created_by)
    values(item->>'product_id',item->>'product_code',item->>'product_name',(item->>'list_position')::int,
      item->'params',item->'calculation',item->>'fingerprint',item->>'cost_source',
      (item->>'cost_date')::date,(item->>'previous_value')::numeric,(item->>'proposed_value')::numeric,p_actor)
    returning * into inserted;
    insert into quirofano_price_events(liquidation_id,actor,event) values(inserted.id,p_actor,'created');
    ids := ids || jsonb_build_array(to_jsonb(inserted));
  end loop;
  return ids;
end $$;

create or replace function public.quirofano_claim_price(p_id uuid, p_actor uuid)
returns jsonb language plpgsql set search_path = public as $$
declare row public.quirofano_liquidations;
begin
  select * into row from quirofano_liquidations where id=p_id for update;
  if not found or row.status <> 'draft' then raise exception 'QF_STATE'; end if;
  begin
    insert into quirofano_product_locks(product_id,liquidation_id) values(row.product_id,row.id);
  exception when unique_violation then raise exception 'QF_CONFLICT'; end;
  update quirofano_liquidations set status='applying',approved_by=p_actor,approved_at=now(),error=null where id=p_id
    returning * into row;
  insert into quirofano_price_events(liquidation_id,actor,event) values(p_id,p_actor,'approved');
  return to_jsonb(row);
end $$;

create or replace function public.quirofano_finish_price(p_id uuid, p_actor uuid, p_status text, p_error text default null)
returns jsonb language plpgsql set search_path = public as $$
declare row public.quirofano_liquidations;
begin
  if p_status not in ('applied','review','conflict') then raise exception 'QF_STATE'; end if;
  select * into row from quirofano_liquidations where id=p_id for update;
  if not found or row.status not in ('applying','review') then raise exception 'QF_STATE'; end if;
  update quirofano_liquidations set status=p_status,error=p_error,
    verified_at=case when p_status='applied' then now() else null end where id=p_id returning * into row;
  if p_status in ('applied','conflict') then delete from quirofano_product_locks where liquidation_id=p_id; end if;
  insert into quirofano_price_events(liquidation_id,actor,event,detail)
    values(p_id,p_actor,p_status,jsonb_build_object('error',p_error));
  return to_jsonb(row);
end $$;

create or replace function public.quirofano_acquire_sync(p_id text, p_owner uuid)
returns boolean language plpgsql set search_path = public as $$
begin
  insert into quirofano_sync_locks(id,owner,expires_at) values(p_id,p_owner,now()+interval '5 minutes')
    on conflict(id) do update set owner=excluded.owner,expires_at=excluded.expires_at
    where quirofano_sync_locks.expires_at < now();
  return found;
end $$;

create or replace function public.quirofano_release_sync(p_id text, p_owner uuid)
returns void language sql set search_path = public as $$
  delete from quirofano_sync_locks where id=p_id and owner=p_owner;
$$;

create or replace function public.quirofano_replace_purchase(p_id uuid, p_header jsonb, p_lines jsonb)
returns void language plpgsql set search_path = public as $$
declare old_date date; codes text[];
begin
  perform 1 from quirofano_purchase_sources where id=p_id for update;
  if not found then raise exception 'QF_STATE'; end if;
  select purchase_date into old_date from quirofano_purchase_invoices where id=p_id;
  select array_agg(distinct code) into codes from (
    select code from quirofano_purchase_lines where invoice_id=p_id
    union select value->>'code' from jsonb_array_elements(p_lines)
  ) affected;
  insert into quirofano_purchase_invoices(id,purchase_date,supplier,total)
  values(p_id,(p_header->>'date')::date,p_header->>'supplier',(p_header->>'total')::numeric)
  on conflict(id) do update set purchase_date=excluded.purchase_date,supplier=excluded.supplier,
    total=excluded.total,synced_at=now();
  delete from quirofano_purchase_lines where invoice_id=p_id;
  insert into quirofano_purchase_lines(invoice_id,line_number,code,description,quantity,unit_cost,net_total,
    supplier,supplier_name,purchase_date)
  select p_id,x.line_number,x.code,x.description,x.quantity,x.unit_cost,x.net_total,x.supplier,x.supplier_name,x.purchase_date
    from jsonb_to_recordset(p_lines) as x(line_number int,code text,description text,quantity numeric,
      unit_cost numeric,net_total numeric,supplier text,supplier_name text,purchase_date date);
  update quirofano_products p set purchase_cost=(
    select sum(l.net_total)/sum(l.quantity) from quirofano_purchase_lines l
    where l.code=p.code and l.purchase_date=(select max(h.purchase_date) from quirofano_purchase_lines h where h.code=p.code)
  ),cost_date=(select max(l.purchase_date) from quirofano_purchase_lines l where l.code=p.code) where p.code=any(codes);
  delete from quirofano_daily_summary where id in (old_date,(p_header->>'date')::date);
  insert into quirofano_daily_summary(id,invoices,lines,net_total)
    select purchase_date,count(distinct invoice_id)::int,count(*)::int,sum(net_total)
    from quirofano_purchase_lines where purchase_date in (old_date,(p_header->>'date')::date) group by purchase_date;
  update quirofano_purchase_sources set checked_at=now(),next_check_at=now()+interval '1 hour',error=null where id=p_id;
end $$;

create or replace function public.quirofano_sync_products(p_rows jsonb)
returns void language plpgsql set search_path = public as $$
begin
  insert into quirofano_products(id,code,name,category,active,tax_rate,tax_error,payload,synced_at)
  select x.id,x.code,x.name,x.category,x.active,x.tax_rate,x.tax_error,x.payload,now()
  from jsonb_to_recordset(p_rows) as x(id text,code text,name text,category text,active boolean,
    tax_rate numeric,tax_error text,payload jsonb)
  on conflict(id) do update set code=excluded.code,name=excluded.name,category=excluded.category,
    active=excluded.active,tax_rate=excluded.tax_rate,tax_error=excluded.tax_error,
    payload=excluded.payload,synced_at=excluded.synced_at;
  update quirofano_products p set purchase_cost=(
    select sum(l.net_total)/sum(l.quantity) from quirofano_purchase_lines l
    where l.code=p.code and l.purchase_date=(select max(h.purchase_date) from quirofano_purchase_lines h where h.code=p.code)
  ),cost_date=(select max(l.purchase_date) from quirofano_purchase_lines l where l.code=p.code)
  where p.id in (select value->>'id' from jsonb_array_elements(p_rows));
end $$;

do $$
declare name text;
begin
  foreach name in array array['quirofano_products','quirofano_catalogs','quirofano_liquidations','quirofano_price_events',
    'quirofano_product_locks','quirofano_purchase_sources','quirofano_purchase_invoices','quirofano_purchase_lines','quirofano_daily_summary','quirofano_sync_locks'] loop
    execute format('alter table public.%I enable row level security',name);
    execute format('revoke all on public.%I from anon, authenticated',name);
    execute format('grant select,insert,update,delete on public.%I to service_role',name);
  end loop;
end $$;
revoke all on function public.quirofano_save_liquidations(jsonb,uuid) from public,anon,authenticated;
revoke all on function public.quirofano_claim_price(uuid,uuid) from public,anon,authenticated;
revoke all on function public.quirofano_finish_price(uuid,uuid,text,text) from public,anon,authenticated;
revoke all on function public.quirofano_acquire_sync(text,uuid) from public,anon,authenticated;
revoke all on function public.quirofano_release_sync(text,uuid) from public,anon,authenticated;
revoke all on function public.quirofano_replace_purchase(uuid,jsonb,jsonb) from public,anon,authenticated;
revoke all on function public.quirofano_sync_products(jsonb) from public,anon,authenticated;
grant execute on function public.quirofano_save_liquidations(jsonb,uuid),public.quirofano_claim_price(uuid,uuid),
  public.quirofano_finish_price(uuid,uuid,text,text),public.quirofano_acquire_sync(text,uuid),
  public.quirofano_release_sync(text,uuid),public.quirofano_replace_purchase(uuid,jsonb,jsonb),
  public.quirofano_sync_products(jsonb) to service_role;

commit;
