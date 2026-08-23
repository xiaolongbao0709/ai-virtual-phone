export default async () => {
  const baseUrl = process.env.URL;

  const response = await fetch(`${baseUrl}/api/push/cron`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.CLIENT_TOKEN}`,
      "Content-Type": "application/json",
    },
  });

  const text = await response.text();

  console.log("Float cron:", response.status, text);

  if (!response.ok) {
    throw new Error(`Float cron failed: ${response.status}`);
  }

  return new Response(text, {
    status: 200,
    headers: {
      "Content-Type": "application/json",
    },
  });
};

export const config = {
  schedule: "*/5 * * * *",
};
