import { Handler, ServiceProviderImpl } from "@zuplo/runtime";
import routeLoader from "zuplo:routes";
import * as schemaValidations from "zuplo:schema-validations";
import { runtimeInit } from "zuplo:runtime-extension";
import runtimeSettings from "zuplo:runtime-settings";
import buildEnvironment from "./build.json";

// Instantiate services
const serviceProvider = new ServiceProviderImpl();

// This is needed because we are using worker script (instead of module)
// And we need to make this available outside of this file.
globalThis["__ZUPLO_SERVICE_PROVIDER"] = serviceProvider;

const handler = new Handler(
  routeLoader,
  buildEnvironment,
  runtimeSettings,
  serviceProvider,
  schemaValidations,
  runtimeInit
);

export default {
  fetch(request, env, ctx) {
    return handler.requestHandler(request, env, ctx)
  },
};
