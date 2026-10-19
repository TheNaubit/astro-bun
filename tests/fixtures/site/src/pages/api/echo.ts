import type { APIRoute } from "astro";
export const POST: APIRoute = async ({ request, clientAddress, cookies }) => {
	cookies.set("one", "1", { path: "/" });
	cookies.set("two", "2", { path: "/" });
	return Response.json({ text: await request.text(), clientAddress });
};
