import { defineRailway, github, project, service } from "railway/iac";
// This repository manages only its own resources in the environment. Other
// repositories export their own partial name. The Postgres service is not
// declared here, so this file never changes or removes it.
// See https://docs.railway.com/infrastructure-as-code#multi-repo-projects
export const partial = "fluentflow-server";
export default defineRailway(() => {
  const _fluentflowserver = service("@fluentflow/server", {
    source: github("alanreyes24/fluentflow", { branch: "main", checkSuites: false }),
    // buildCommand is ignored by the DOCKERFILE builder; it mirrors the
    // service's stored value so plans stay clean.
    build: { buildCommand: "npm run build --workspace=@fluentflow/server", buildEnvironment: "V3", builder: "DOCKERFILE", dockerfilePath: "Dockerfile", watchPatterns: ["/Dockerfile", "/package.json", "/package-lock.json", "/apps/server/**", "/apps/mobile/**", "/packages/core/**"] },
    start: "node apps/server/src/index.ts",
    healthcheck: "/health",
    healthcheckTimeout: 120,
    // Sleep after ~10 idle minutes; the next request wakes it (a few seconds'
    // cold start). The pg pool closes idle connections, so it can go quiet.
    deploy: { sleepApplication: true, restartPolicyType: "ON_FAILURE" },
    replicas: { "us-east4-eqdc4a": 1 },
    networking: { privateNetworkEndpoint: "fluentflowserver" },
  });

  return project("fluentflow", {
    variables: { managed: false },
    resources: [_fluentflowserver],
  });
});
