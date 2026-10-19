import type { APIRoute } from "astro";
export const POST: APIRoute = async ({ cache }) => {
	await cache.invalidate({ tags: ["pages"] });
	return new Response("Invalidated");
};
