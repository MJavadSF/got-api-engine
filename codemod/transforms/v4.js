// got-api-engine v3 → v4 codemod (jscodeshift).
//
// 1. Automatic, behaviour-preserving rewrites:
//    - cache.cloneOnRead: false → copy: "none"   (true → removed: it is the default)
//    - deprecated BrowserStorageAuthProvider / createBrowserStorageAuth → TODO comment
// 2. Opt-in `--preserve-behavior`: pin v3 defaults explicitly so the upgrade changes nothing:
//    - engine config: totalTimeoutMs: 0, strictPath: false, circuitBreaker.scope: "engine"
//    - Next handleRoute / createProxy options: forwardClientIp: true
// 3. Reports (no change) for code that needs a human decision:
//    - `status === 500` checks (NETWORK_ERROR is now 502)
//    - `body: null` (now sent as JSON null), successCount / errorCount (new semantics)
//    - handleRoute without forwardClientIp (X-Forwarded-For no longer forwarded)
//    - deep imports into the package internals
//
// Only files importing "got-api-engine" (or a subpath) are touched.

"use strict";

const PKG = /^got-api-engine(\/(next|node|redis|testing|codegen))?$/;
const DEEP = /^got-api-engine\/(dist|src)\//;
const ENGINE_FACTORIES = new Set(["createEngine", "createNextEngine"]);
const ENGINE_CLASSES = new Set(["GotApiEngine", "NextApiEngine"]);
const TODO_TAG = "TODO(got-api-engine v4)";

/** @param {import("jscodeshift").FileInfo} file @param {import("jscodeshift").API} api */
module.exports = function transform(file, api, options = {}) {
  const j = api.jscodeshift;
  const root = j(file.source);
  const preserve = Boolean(options.preserveBehavior ?? options["preserve-behavior"]);
  const report = (node, message) => {
    const line = node?.loc?.start?.line ?? "?";
    api.report(`${file.path}:${line} ${message}`);
  };

  // ── Scope: files that use the package ──────────────────────────
  const imports = root.find(j.ImportDeclaration).filter((p) => {
    const src = String(p.node.source.value);
    if (DEEP.test(src)) report(p.node, `deep import "${src}" — use the public entry points (got-api-engine, /next, /node, /redis, /testing)`);
    return PKG.test(src) || DEEP.test(src);
  });
  const requires = root.find(j.CallExpression, { callee: { name: "require" } }).filter((p) => {
    const arg = p.node.arguments[0];
    return arg && (arg.type === "StringLiteral" || arg.type === "Literal") && (PKG.test(String(arg.value)) || DEEP.test(String(arg.value)));
  });
  if (imports.size() === 0 && requires.size() === 0) return undefined;

  let changed = false;
  const keyName = (prop) => (prop.key?.type === "Identifier" ? prop.key.name : prop.key?.value);
  const isProp = (prop) => prop.type === "ObjectProperty" || prop.type === "Property";
  const findProp = (obj, name) => obj.properties.find((p) => isProp(p) && keyName(p) === name);
  const addProp = (obj, name, valueNode) => {
    obj.properties.push(j.objectProperty(j.identifier(name), valueNode));
    changed = true;
  };
  const addComment = (path, text) => {
    const stmt = j(path).closest(j.Statement).get();
    const node = stmt.node;
    node.comments = node.comments ?? [];
    if (!node.comments.some((c) => String(c.value).includes(TODO_TAG))) {
      node.comments.push(j.commentLine(` ${TODO_TAG}: ${text}`, true, false));
      changed = true;
    }
  };

  // ── 1a. cache.cloneOnRead → copy ───────────────────────────────
  root.find(j.ObjectExpression).forEach((path) => {
    const obj = path.node;
    const clone = findProp(obj, "cloneOnRead");
    if (!clone) return;
    const v = clone.value;
    const isBool = v.type === "BooleanLiteral" || (v.type === "Literal" && typeof v.value === "boolean");
    if (!isBool) {
      report(clone, "cloneOnRead with a non-literal value — replace with copy: \"clone\" | \"freeze\" | \"none\" manually");
      return;
    }
    obj.properties = obj.properties.filter((p) => p !== clone);
    if (v.value === false && !findProp(obj, "copy")) obj.properties.push(j.objectProperty(j.identifier("copy"), j.stringLiteral("none")));
    changed = true;
  });

  // ── 1b. deprecated browser-storage auth ────────────────────────
  root
    .find(j.CallExpression, { callee: { name: "createBrowserStorageAuth" } })
    .forEach((p) => addComment(p, "createBrowserStorageAuth is deprecated (removed in v5) — prefer an httpOnly cookie via cookieAuth"));
  root
    .find(j.NewExpression, { callee: { name: "BrowserStorageAuthProvider" } })
    .forEach((p) => addComment(p, "BrowserStorageAuthProvider is deprecated (removed in v5) — prefer an httpOnly cookie via cookieAuth"));

  // ── Engine configs ─────────────────────────────────────────────
  const engineConfigs = [];
  root.find(j.CallExpression).forEach((p) => {
    const callee = p.node.callee;
    if (callee.type === "Identifier" && ENGINE_FACTORIES.has(callee.name) && p.node.arguments[0]?.type === "ObjectExpression") {
      engineConfigs.push(p.node.arguments[0]);
    }
  });
  root.find(j.NewExpression).forEach((p) => {
    const callee = p.node.callee;
    if (callee.type === "Identifier" && ENGINE_CLASSES.has(callee.name) && p.node.arguments[0]?.type === "ObjectExpression") {
      engineConfigs.push(p.node.arguments[0]);
    }
  });

  for (const cfg of engineConfigs) {
    const breaker = findProp(cfg, "circuitBreaker");
    if (preserve) {
      if (!findProp(cfg, "totalTimeoutMs")) addProp(cfg, "totalTimeoutMs", j.numericLiteral(0));
      if (!findProp(cfg, "strictPath")) addProp(cfg, "strictPath", j.booleanLiteral(false));
      if (breaker?.value.type === "ObjectExpression" && !findProp(breaker.value, "scope")) {
        addProp(breaker.value, "scope", j.stringLiteral("engine"));
      }
    } else if (breaker?.value.type === "ObjectExpression" && !findProp(breaker.value, "scope")) {
      report(breaker, 'circuitBreaker is now per host — add scope: "engine" to keep one breaker per engine (or run with --preserve-behavior)');
    }
  }

  // ── Next.js route options ──────────────────────────────────────
  const routeOptions = [];
  root.find(j.CallExpression).forEach((p) => {
    const callee = p.node.callee;
    const name = callee.type === "MemberExpression" ? keyName({ key: callee.property }) : callee.name;
    if (name === "handleRoute" && p.node.arguments[1]?.type === "ObjectExpression") routeOptions.push(p.node.arguments[1]);
    if (name === "createProxy" && p.node.arguments[1]?.type === "ObjectExpression") routeOptions.push(p.node.arguments[1]);
  });
  for (const opts of routeOptions) {
    if (findProp(opts, "forwardClientIp")) continue;
    if (preserve) addProp(opts, "forwardClientIp", j.booleanLiteral(true));
    else report(opts, "X-Forwarded-For is no longer forwarded by default — set forwardClientIp: true only behind a trusted proxy");
  }

  // ── Reports ────────────────────────────────────────────────────
  root.find(j.BinaryExpression).forEach((p) => {
    const { left, right, operator } = p.node;
    if (!["===", "==", "!==", "!="].includes(operator)) return;
    const isStatus = (n) => n.type === "MemberExpression" && keyName({ key: n.property }) === "status";
    const is500 = (n) => (n.type === "NumericLiteral" || n.type === "Literal") && n.value === 500;
    if ((isStatus(left) && is500(right)) || (isStatus(right) && is500(left))) {
      report(p.node, 'status 500 check — network failures are now 502 with code "NETWORK_ERROR"; prefer checking result.code');
    }
  });
  root.find(j.ObjectExpression).forEach((p) => {
    const body = findProp(p.node, "body");
    if (body && (body.value.type === "NullLiteral" || (body.value.type === "Literal" && body.value.value === null))) {
      report(body, "body: null is now sent as a JSON null body (v3 sent no body) — remove it to send none");
    }
  });
  root.find(j.MemberExpression).forEach((p) => {
    const name = keyName({ key: p.node.property });
    if (name === "successCount" || name === "errorCount") {
      report(p.node, `${name} now counts results returned by request() (cache hits included); upstream attempts are upstreamRequests / upstreamErrors`);
    }
  });

  return changed ? root.toSource({ quote: "double" }) : undefined;
};

module.exports.parser = "tsx";
