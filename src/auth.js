import { DomainError } from "./domain/pricing.js";

export const covers = (permission, path) => path === permission || path.startsWith(`${permission}/`);
const paths = (routes) => Array.isArray(routes)
  ? routes.map((route) => typeof route === "string" ? route : route?.path).filter((path) => typeof path === "string" && path)
  : [];

export function canAccess(profile, role, path = "/quirofano") {
  const personal = paths(profile?.personal_routes);
  return (personal.length ? personal : paths(role?.permissions)).some((p) => covers(p, path)) || role?.redirect === path;
}

export function canEditPrices(profile, role) {
  return canAccess(profile, role);
}



export function authorize(client) {
  return async (req, _res, next) => {
    try {
      const token = /^Bearer +(\S+)$/i.exec(req.headers.authorization || "")?.[1];
      if (!token) throw new DomainError("Inicie sesion para continuar.", 401);
      const scoped = typeof client === "function" ? client(token) : client;
      if (!scoped) throw new DomainError("Supabase no esta configurado en el backend.", 503);
      const { data: userData, error: userError } = await scoped.auth.getUser(token);
      if (userError && (!userError.status || userError.status >= 500)) throw new DomainError("Supabase no pudo verificar la sesion. Intente nuevamente.", 503);
      if (userError || !userData?.user) throw new DomainError("La sesion no es valida o vencio.", 401);
      const { data: profile, error } = await scoped.from("profiles").select("role,personal_routes")
        .eq("user_id", userData.user.id).maybeSingle();
      if (error) throw new DomainError("No fue posible consultar sus permisos.", 503);
      if (!profile) throw new DomainError("Su usuario no tiene un perfil asignado.", 403);
      let role = null;
      if (profile.role) {
        const result = await scoped.from("role_permissions").select("permissions,redirect").eq("role", profile.role).maybeSingle();
        if (result.error) throw new DomainError("No fue posible consultar los permisos del rol.", 503);
        role = result.data;
      }
      if (!canAccess(profile, role)) throw new DomainError("Su usuario no tiene acceso a Quirofano.", 403);
      req.userId = userData.user.id;
      req.canEditPrices = canEditPrices(profile, role);
      req.supabase = scoped;
      return next();
    } catch (error) {
      return next(error);
    }
  };
}
