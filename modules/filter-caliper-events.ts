import { ZuploContext, ZuploRequest, environment } from "@zuplo/runtime";

type SolaceConfig = {
  username: string;
  password: string;
  deliveryMode?: string;
  topics: {
    login: string;
    course: string;
    task: string;
  };
};

type AllowedEventType = "login" | "course" | "task";

type ResolvedTarget = {
  url: string | null;
  eventType: AllowedEventType | null;
  matchedEvent: any | null;
};

function loadConfig(): SolaceConfig {
  const raw = environment.SOLACE_CONFIG;

  if (!raw) {
    throw new Error("SOLACE_CONFIG no está configurada");
  }

  let parsed: SolaceConfig;
  try {
    parsed = JSON.parse(raw) as SolaceConfig;
  } catch {
    throw new Error("SOLACE_CONFIG no tiene un JSON válido");
  }

  if (
    !parsed.username ||
    !parsed.password ||
    !parsed.topics?.login ||
    !parsed.topics?.course ||
    !parsed.topics?.task
  ) {
    throw new Error(
      "SOLACE_CONFIG está incompleta. Debe incluir username, password y topics.login/course/task",
    );
  }

  return parsed;
}

function normalize(value: unknown): string {
  return String(value ?? "").trim().toLowerCase();
}

function getEvents(body: any): any[] {
  return Array.isArray(body?.data) ? body.data : [body];
}

function getEventKey(event: any): string {
  const type = normalize(event?.type);
  const action = normalize(event?.action);
  return `${type}|${action}`;
}

// CAMBIO: access course ahora exige:
// 1) ViewEvent + Viewed
// 2) group.type = CourseOffering
// 3) membership.organization.type = CourseOffering
// 4) object.type = Chapter
// 5) target.type = Chapter
function isCourseAccessEvent(event: any): boolean {
  return (
    getEventKey(event) === "viewevent|viewed" &&
    normalize(event?.group?.type) === "courseoffering" &&
    normalize(event?.membership?.organization?.type) === "courseoffering" &&
    normalize(event?.object?.type) === "chapter" &&
    normalize(event?.target?.type) === "chapter"
  );
}

function classifyEvent(event: any): AllowedEventType | null {
  const eventKey = getEventKey(event);

  if (eventKey === "sessionevent|loggedin") {
    return "login";
  }

  if (isCourseAccessEvent(event)) {
    return "course";
  }

  if (eventKey === "assignableevent|completed") {
    return "task";
  }

  return null;
}

function resolveTarget(
  events: any[],
  config: SolaceConfig,
): ResolvedTarget {
  const topicByEventType: Record<AllowedEventType, string> = {
    login: config.topics.login,
    course: config.topics.course,
    task: config.topics.task,
  };

  for (const event of events) {
    const eventType = classifyEvent(event);

    if (eventType) {
      return {
        url: topicByEventType[eventType],
        eventType,
        matchedEvent: event,
      };
    }
  }

  return {
    url: null,
    eventType: null,
    matchedEvent: null,
  };
}

function buildBasicAuth(username: string, password: string): string {
  return `Basic ${btoa(`${username}:${password}`)}`;
}

export default async function (
  request: ZuploRequest,
  context: ZuploContext,
): Promise<ZuploRequest | Response> {
  try {
    const rawBody = await request.text();

    if (!rawBody) {
      return new Response(
        JSON.stringify({
          message: "Request body vacío",
        }),
        {
          status: 400,
          headers: {
            "content-type": "application/json",
          },
        },
      );
    }

    let body: any;
    try {
      body = JSON.parse(rawBody);
    } catch {
      return new Response(
        JSON.stringify({
          message: "El body no es JSON válido",
        }),
        {
          status: 400,
          headers: {
            "content-type": "application/json",
          },
        },
      );
    }

    const isEnvelope = Array.isArray(body?.data);
    const events = getEvents(body);
    const config = loadConfig();
    const resolved = resolveTarget(events, config);

    context.log.info("Analizando payload Caliper", {
      esEnvelope: isEnvelope,
      totalEventos: events.length,
      eventos: events.map((event: any) => ({
        type: event?.type,
        action: event?.action,
        eventKey: getEventKey(event),
        objectType: event?.object?.type,
        targetType: event?.target?.type,
        groupType: event?.group?.type,
        membershipOrganizationType: event?.membership?.organization?.type,
        clasificacion: classifyEvent(event),
      })),
      clasificacionDetectada: resolved.eventType,
    });

    if (!resolved.url || !resolved.matchedEvent || !resolved.eventType) {
      context.log.info("Evento ignorado", {
        esEnvelope: isEnvelope,
        totalEventos: events.length,
        eventos: events.map((event: any) => ({
          type: event?.type,
          action: event?.action,
          eventKey: getEventKey(event),
          objectType: event?.object?.type,
          targetType: event?.target?.type,
          groupType: event?.group?.type,
          membershipOrganizationType: event?.membership?.organization?.type,
        })),
        razon: "No coincide con eventos permitidos",
      });

      return new Response(null, {
        status: 204,
      });
    }

    const target = new URL(resolved.url);
    const headers = new Headers(request.headers);

    headers.set("Authorization", buildBasicAuth(config.username, config.password));
    headers.set("Solace-delivery-mode", config.deliveryMode ?? "direct");
    headers.set("Content-Type", "application/json");

    headers.delete("host");
    headers.delete("content-length");

    context.custom.solaceOrigin = target.origin;

    const outboundBody =
      resolved.eventType === "task"
        ? rawBody
        : JSON.stringify(resolved.matchedEvent);

    context.log.info("Enrutando evento a Solace", {
      eventType: resolved.eventType,
      matchedType: resolved.matchedEvent?.type,
      matchedAction: resolved.matchedEvent?.action,
      matchedEventKey: getEventKey(resolved.matchedEvent),
      matchedObjectType: resolved.matchedEvent?.object?.type,
      matchedTargetType: resolved.matchedEvent?.target?.type,
      matchedGroupType: resolved.matchedEvent?.group?.type,
      matchedMembershipOrganizationType:
        resolved.matchedEvent?.membership?.organization?.type,
      targetOrigin: target.origin,
      targetPath: target.pathname,
      esEnvelopeEntrada: isEnvelope,
      totalEventosEntrada: events.length,
      payloadNormalizado:
        resolved.eventType === "login" || resolved.eventType === "course",
      payloadOriginalPreservado: resolved.eventType === "task",
    });

    return new ZuploRequest(target.toString(), {
      method: request.method,
      headers,
      body: outboundBody,
      user: request.user,
      params: request.params,
    });
  } catch (error: any) {
    context.log.error("Error inesperado en handler Caliper -> Solace", {
      message: error?.message ?? "Unknown error",
      stack: error?.stack,
    });

    return new Response(
      JSON.stringify({
        message: "Error interno al procesar el evento",
        detail: error?.message ?? "Unknown error",
      }),
      {
        status: 500,
        headers: {
          "content-type": "application/json",
        },
      },
    );
  }
}