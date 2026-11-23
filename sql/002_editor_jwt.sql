begin;

create table if not exists public.quirofano_editor_requests (
  nonce uuid primary key,
  actor uuid not null,
  created_at timestamptz not null default now()
);
create index if not exists quirofano_editor_requests_created on public.quirofano_editor_requests(created_at);
alter table public.quirofano_editor_requests enable row level security;
revoke all on public.quirofano_editor_requests from public, anon, authenticated;

-- Conservar el parametro para las politicas instaladas; consultar y editar usan el mismo permiso.
create or replace function public.quirofano_editor_access(p_edit boolean default false)
returns boolean language plpgsql stable security definer set search_path = pg_catalog, public as $$
declare
  personal jsonb;
  role_name text;
  role_routes jsonb;
  role_redirect text;
  permissions text[];
  module_allowed boolean;
begin
  if auth.uid() is null then return false; end if;
  select to_jsonb(p.personal_routes), p.role::text into personal, role_name
    from public.profiles p where p.user_id = auth.uid();
  if not found then return false; end if;
  select to_jsonb(r.permissions), r.redirect into role_routes, role_redirect
    from public.role_permissions r where r.role::text = role_name;
  select coalesce(array_agg(path), array[]::text[]) into permissions from (
    select case jsonb_typeof(value) when 'string' then value #>> '{}'
      when 'object' then case when jsonb_typeof(value->'path') = 'string' then value->>'path' end end as path
    from jsonb_array_elements(case when jsonb_typeof(personal) = 'array' then personal else '[]'::jsonb end)
  ) routes where path is not null and path <> '';
  if cardinality(permissions) = 0 then
    select coalesce(array_agg(path), array[]::text[]) into permissions from (
      select case jsonb_typeof(value) when 'string' then value #>> '{}'
        when 'object' then case when jsonb_typeof(value->'path') = 'string' then value->>'path' end end as path
      from jsonb_array_elements(case when jsonb_typeof(role_routes) = 'array' then role_routes else '[]'::jsonb end)
    ) routes where path is not null and path <> '';
  end if;
  module_allowed := coalesce(role_redirect = '/quirofano', false) or exists (
    select 1 from unnest(permissions) permission
      where permission = '/quirofano' or left('/quirofano', length(permission) + 1) = permission || '/'
  );
  return module_allowed;
end $$;
revoke all on function public.quirofano_editor_access(boolean) from public, anon;
grant execute on function public.quirofano_editor_access(boolean) to authenticated;

do $$
declare table_name text;
begin
  foreach table_name in array array['quirofano_products', 'quirofano_catalogs', 'quirofano_liquidations', 'quirofano_price_events'] loop
    execute format('revoke all on public.%I from anon, authenticated', table_name);
    execute format('grant select on public.%I to authenticated', table_name);
    execute format('drop policy if exists quirofano_editor_read on public.%I', table_name);
    execute format('create policy quirofano_editor_read on public.%I for select to authenticated using (public.quirofano_editor_access(false))', table_name);
  end loop;
end $$;

drop function if exists public.quirofano_editor_command(text,text);
create or replace function public.quirofano_editor_command(p_envelope text)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  envelope jsonb;
  operation text;
  data jsonb;
  actor uuid := auth.uid();
  product_row public.quirofano_products;
begin
  if actor is null or not public.quirofano_editor_access(true) then
    raise exception 'QF_PERMISSION: editor permission required' using errcode = '42501';
  end if;
  if p_envelope is null or octet_length(p_envelope) > 131072 then
    raise exception 'QF_REQUEST: invalid envelope' using errcode = '42501';
  end if;
  envelope := p_envelope::jsonb;
  if jsonb_typeof(envelope) is distinct from 'object' or (envelope->>'actor')::uuid is distinct from actor
    or envelope->>'issuedAt' is null or envelope->>'nonce' is null
    or abs(extract(epoch from (clock_timestamp() - (envelope->>'issuedAt')::timestamptz))) > 120 then
    raise exception 'QF_REQUEST: expired or mismatched request' using errcode = '42501';
  end if;
  operation := envelope->>'operation';
  data := envelope->'data';
  delete from public.quirofano_editor_requests where created_at < now() - interval '10 minutes';
  insert into public.quirofano_editor_requests(nonce, actor) values((envelope->>'nonce')::uuid, actor);

  case operation
    when 'snapshot' then
      insert into public.quirofano_products(id,code,name,category,active,tax_rate,tax_error,purchase_cost,cost_date,payload,synced_at)
      select x.id,x.code,x.name,x.category,x.active,x.tax_rate,x.tax_error,x.purchase_cost,x.cost_date,x.payload,now()
        from jsonb_to_record(data) as x(id text,code text,name text,category text,active boolean,tax_rate numeric,
          tax_error text,purchase_cost numeric,cost_date date,payload jsonb)
      on conflict(id) do update set code=excluded.code,name=excluded.name,category=excluded.category,active=excluded.active,
        tax_rate=excluded.tax_rate,tax_error=excluded.tax_error,purchase_cost=excluded.purchase_cost,
        cost_date=excluded.cost_date,payload=excluded.payload,synced_at=excluded.synced_at
      returning * into product_row;
      return to_jsonb(product_row);
    when 'catalogs' then
      insert into public.quirofano_catalogs(id,data,synced_at)
        select x.id,x.data,now() from jsonb_to_recordset(data) as x(id text,data jsonb)
        on conflict(id) do update set data=excluded.data,synced_at=excluded.synced_at;
      return data;
    when 'prepare' then
      if jsonb_array_length(data->'p_rows') <> 1 then raise exception 'QF_STATE: one product required'; end if;
      return public.quirofano_save_liquidations(data->'p_rows', actor);
    when 'claim' then
      return public.quirofano_claim_price((data->>'p_id')::uuid, actor);
    when 'finish' then
      return public.quirofano_finish_price((data->>'p_id')::uuid, actor, data->>'p_status', data->>'p_error');
    when 'verified-product' then
      update public.quirofano_products set payload=data->'payload',synced_at=now() where id=data->>'id'
        returning * into product_row;
      if not found then raise exception 'QF_STATE: product not found'; end if;
      return to_jsonb(product_row);
    else
      raise exception 'QF_PERMISSION: operation not allowed' using errcode = '42501';
  end case;
end $$;
revoke all on function public.quirofano_editor_command(text) from public, anon;
grant execute on function public.quirofano_editor_command(text) to authenticated;

commit;
