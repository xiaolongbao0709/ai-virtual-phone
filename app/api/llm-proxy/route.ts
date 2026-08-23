export async function POST(request: Request) {
    try {
        const { url, headers, body } = await request.json();

        if (!url || typeof url !== "string") {
            return Response.json(
                { error: "Missing target URL" },
                { status: 400 },
            );
        }

        const response = await fetch(url, {
            method: "POST",
            headers: headers ?? {},
            body: typeof body === "string" ? body : JSON.stringify(body),
        });

        const responseBody = await response.text();

        return new Response(responseBody, {
            status: response.status,
            headers: {
                "Content-Type":
                    response.headers.get("Content-Type") ?? "application/json",
            },
        });
    } catch (error) {
        return Response.json(
            {
                error:
                    error instanceof Error
                        ? error.message
                        : String(error),
            },
            { status: 500 },
        );
    }
}
