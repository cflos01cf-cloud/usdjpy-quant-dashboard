/** Protección simple para rutas que cambian estado: header `x-admin-token` = ADMIN_TOKEN. */
export function isAdmin(req: Request): boolean {
  const t = process.env.ADMIN_TOKEN;
  return !!t && req.headers.get("x-admin-token") === t;
}
