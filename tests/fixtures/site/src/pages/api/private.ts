import type { APIRoute } from "astro";
export const GET: APIRoute = ({ cache, cookies }) => {
	cache.set({ maxAge: 60 });
	cookies.set("private", crypto.randomUUID(), { path: "/" });
	return new Response(crypto.randomUUID());
};
