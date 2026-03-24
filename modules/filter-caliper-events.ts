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

function joinEventText(event: any): string {
  return [
    event?.type,
    event?.action,

    event?.object?.type,
    event?.object?.id,
    event?.object?.name,

    event?.target?.type,
    event?.target?.id,
    event?.target?.name,

    event?.generated?.type,
    event?.generated?.id,

    event?.group?.type,
    event?.group?.id,
    event?.group?.courseNumber,
    event?.group?.extensions?.["bb:course.id"],
    event?.group?.extensions?.["bb:course.externalId"],

    event?.membership?.type,
    event?.membership?.id,
    event?.membership?.extensions?.["bb:course.id"],
    event?.membership?.extensions?.["bb:course.externalId"],
    event?.membership?.organization?.type,
    event?.membership?.organization?.id,
    event?.membership?.organization?.courseNumber,
    event?.membership?.organization?.extensions?.["bb:course.id"],
    event?.membership?.organization?.extensions?.["bb:course.externalId"],
  ]
    .map((v) => normalize(v))
    .join(" | ");
}

function isLoginEvent(event: any): boolean {
  return (
    normalize(event?.type) === "sessionevent" &&
    normalize(event?.action) === "loggedin"
  );
}

function isCourseEvent(event: any): boolean {
  const type = normalize(event?.type);
  const action = normalize(event?.action);
  const text = joinEventText(event);

  const typeMatch =
    type === "viewevent" ||
    type === "navigationevent";

  const actionMatch = [
    "accessed",
    "viewed",
    "opened",
    "navigatedto",
  ].includes(action);

  const courseContextMatch =
    text.includes("courseoffering") ||
    text.includes("coursesection") ||
    text.includes("/courses/") ||
    text.includes("/course/") ||
    text.includes("bb:course.id") ||
    text.includes("pt4604") || // opcional, puedes quitarlo luego
    !!event?.group ||
    !!event?.membership;

  return typeMatch && actionMatch && courseContextMatch;
}

function isTaskEvent(event: any): boolean {
  const action = normalize(event?.action);
  const text = joinEventText(event);

  const actionMatch =
    action === "submitted" ||
    action === "completed";

  const objectMatch =
    text.includes("assignment") ||
    text.includes("assignable") ||
    text.includes("assignableevent") ||
    text.includes("task") ||
    text.includes("attempt") ||
    text.includes("submission") ||
    text.includes("assigned");

  return objectMatch && actionMatch;
}

function classifyEvent(event: any): "login" | "course" | "task" | null {
  if (isLoginEvent(event)) {
    return "login";
  }

  if (isCourseEvent(event)) {
    return "course";
  }

  if (isTaskEvent(event)) {
    return "task";
  }

  return null;
}

function resolveTarget(
  events: any[],
  config: SolaceConfig,
): {
  url: string | null;
  eventType: "login" | "course" | "task" | null;
  matchedEvent: any | null;
} {
  for (const event of events) {
    const eventType = classifyEvent(event);

    if (eventType === "login") {
      return {
        url: config.topics.login,
        eventType,
        matchedEvent: event,
      };
    }

    if (eventType === "course") {
      return {
        url: config.topics.course,
        eventType,
        matchedEvent: event,
      };
    }

    if (eventType === "task") {
      return {
        url: config.topics.task,
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

  const events = getEvents(body);
  const config = loadConfig();
  const resolved = resolveTarget(events, config);

  context.log.info("Analizando payload Caliper", {
    esEnvelope: Array.isArray(body?.data),
    totalEventos: events.length,
    eventos: events.map((event: any) => ({
      type: event?.type,
      action: event?.action,
      groupType: event?.group?.type,
      membershipType: event?.membership?.type,
    })),
    clasificacionDetectada: resolved.eventType,
  });

  if (!resolved.url || !resolved.matchedEvent) {
    context.log.info("Evento ignorado", {
      esEnvelope: Array.isArray(body?.data),
      totalEventos: events.length,
      eventos: events.map((event: any) => ({
        type: event?.type,
        action: event?.action,
        groupType: event?.group?.type,
        membershipType: event?.membership?.type,
      })),
    });

    return new Response(
      JSON.stringify({
        ignored: true,
        reason: "Unsupported Caliper event",
      }),
      {
        status: 202,
        headers: {
          "content-type": "application/json",
        },
      },
    );
  }

  const target = new URL(resolved.url);
  const headers = new Headers(request.headers);

  headers.set("Authorization", buildBasicAuth(config.username, config.password));
  headers.set("Solace-delivery-mode", config.deliveryMode ?? "direct");
  headers.set("Content-Type", "application/json");

  headers.delete("host");
  headers.delete("content-length");

  context.custom.solaceOrigin = target.origin;

  // Regla de salida por tipo de evento:
  // login y course -> plano
  // task -> conservar formato original (porque Boomi task espera envelope)
  const outboundBody =
    resolved.eventType === "task"
      ? rawBody
      : JSON.stringify(resolved.matchedEvent);

  context.log.info("Enrutando evento a Solace", {
    eventType: resolved.eventType,
    matchedType: resolved.matchedEvent?.type,
    matchedAction: resolved.matchedEvent?.action,
    targetOrigin: target.origin,
    targetPath: target.pathname,
    esEnvelopeEntrada: Array.isArray(body?.data),
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
}