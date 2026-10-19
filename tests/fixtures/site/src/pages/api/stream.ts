export const GET = () =>
	new Response(
		new ReadableStream({
			async start(controller) {
				controller.enqueue(new TextEncoder().encode("first\n"));
				await Bun.sleep(100);
				controller.enqueue(new TextEncoder().encode("last\n"));
				controller.close();
			},
		}),
		{ headers: { "content-type": "text/plain" } },
	);
