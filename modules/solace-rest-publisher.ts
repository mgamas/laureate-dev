import { ZuploRequest, ZuploContext, environment } from "@zuplo/runtime";

function toBasicAuth(username: string, password: string): string {
  return "Basic " + btoa(`${username}:${password}`);
}

function resolveSolaceUrl(body: any): string | undefined {
  const rootType = body?.type;
  const rootAction = body?.action;

  const dataEvents = Array.isArray(body?.data) ? body.data : [];

  const esLogin =
    rootType === "SessionEvent" &&
    rootAction === "LoggedIn";

  const esAccesoCurso =
    rootType === "ViewEvent" &&
    rootAction === "Viewed";

  const esEntregaTarea = dataEvents.some(
    (event: any) =>
      event?.type === "AssignableEvent" &&
      event?.action === "Completed"
  );

  if (esLogin) {
    return environment.SOLACE_TOPIC_LOGIN_URL;
  }

  if (esAccesoCurso) {
    return environment.SOLACE_TOPIC_COURSE_URL;
  }

  if (esEntregaTarea) {
    return environment.SOLACE_TOPIC_TASK_URL;
  }

  return undefined;
}

export default async function (
  request: ZuploRequest,
  context: ZuploContext
): Promise<Response> {
  try {
    const bodyText = await request.text();
    const body = JSON.parse(bodyText);

    const url = resolveSolaceUrl(body);
    const username = environment.SOLACE_USERNAME;
    const password = environment.SOLACE_PASSWORD;
    const deliveryMode = (environment.SOLACE_DELIVERY_MODE || "direct").trim().toLowerCase();

    if (!url || !username || !password) {
      return new Response(
        JSON.stringify({
          message: "Faltan variables de entorno de Solace o no se pudo resolver el topic",
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
        "Solace-Delivery-Mode": deliveryMode,
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