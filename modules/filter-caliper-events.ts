import { ZuploRequest, ZuploContext } from "@zuplo/runtime";

export default async function (
  request: ZuploRequest,
  context: ZuploContext
): Promise<ZuploRequest | Response> {
  let body: any;

  try {
    body = await request.json();
  } catch {
    return new Response(
      JSON.stringify({ message: "JSON inválido" }),
      {
        status: 400,
        headers: {
          "content-type": "application/json"
        }
      }
    );
  }

  const rootType = body?.type;
  const rootAction = body?.action;

  const dataEvent = Array.isArray(body?.data) ? body.data[0] : undefined;
  const dataType = dataEvent?.type;
  const dataAction = dataEvent?.action;

  const esLogin =
    rootType === "SessionEvent" &&
    rootAction === "LoggedIn";

  const esAccesoCurso =
    rootType === "ViewEvent" &&
    rootAction === "Viewed";

  const esEntregaTarea =
    dataType === "AssignableEvent" &&
    dataAction === "Completed";

  const permitido = esLogin || esAccesoCurso || esEntregaTarea;

  if (!permitido) {
    return new Response(null, { status: 204 });
  }

  const headers = new Headers(request.headers);
  headers.set("content-type", "application/json");

  return new ZuploRequest(request, {
    headers,
    body: JSON.stringify(body)
  });
}
