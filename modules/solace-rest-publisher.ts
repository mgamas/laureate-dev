import { ZuploRequest, ZuploContext, environment } from "@zuplo/runtime";

function toBasicAuth(username: string, password: string): string {
  return "Basic " + btoa(`${username}:${password}`);
}

export default async function (
  request: ZuploRequest,
  context: ZuploContext
): Promise<Response> {
  try {
    const bodyText = await request.text();

    const url = environment.SOLACE_REST_URL;
    const username = environment.SOLACE_USERNAME;
    const password = environment.SOLACE_PASSWORD;
    const deliveryMode = environment.SOLACE_DELIVERY_MODE || "direct";

    if (!url || !username || !password) {
      return new Response(
        JSON.stringify({
          message: "Faltan variables de entorno de Solace",
          urlExists: !!url,
          usernameExists: !!username,
          passwordExists: !!password
        }),
        {
          status: 500,
          headers: {
            "content-type": "application/json"
          }
        }
      );
    }

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "text/plain",
        "Solace-delivery-mode": deliveryMode,
        "Authorization": toBasicAuth(username, password)
      },
      body: bodyText
    });

    const responseText = await response.text();

    return new Response(responseText, {
      status: response.status,
      headers: {
        "content-type": response.headers.get("content-type") || "text/plain"
      }
    });
  } catch (error: any) {
    return new Response(
      JSON.stringify({
        message: "Error publicando a Solace",
        error: String(error?.message || error)
      }),
      {
        status: 500,
        headers: {
          "content-type": "application/json"
        }
      }
    );
  }
}