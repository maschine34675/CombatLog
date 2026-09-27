import { readFileSync } from "node:fs";

function readSource(path) {
  return readFileSync(path, "utf8").replace(/\r\n/g, "\n");
}

const sources = {
  gate: readSource("UI/WebOverlayGate.cs"),
  panel: readSource("UI/CombatLogPanel.cs"),
  plugin: readSource("Plugin.cs"),
  project: readSource("CombatLog.csproj"),
  guide: readSource("CLAUDE.md"),
};

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
function method(source, marker) {
  const start = source.indexOf(marker);
  if (start < 0) return "";
  const open = source.indexOf("{", start);
  if (open < 0) return "";
  let depth = 0;
  let mode = "code";
  for (let i = open; i < source.length; i++) {
    const c = source[i], n = source[i + 1];
    if (mode === "line") { if (c === "\n") mode = "code"; continue; }
    if (mode === "block") { if (c === "*" && n === "/") { mode = "code"; i++; } continue; }
    if (mode === "string") {
      if (c === "\\") { i++; continue; }
      if (c === '"') mode = "code";
      continue;
    }
    if (mode === "char") {
      if (c === "\\") { i++; continue; }
      if (c === "'") mode = "code";
      continue;
    }
    if (c === "/" && n === "/") { mode = "line"; i++; continue; }
    if (c === "/" && n === "*") { mode = "block"; i++; continue; }
    if (c === '"') { mode = "string"; continue; }
    if (c === "'") { mode = "char"; continue; }
    if (c === "{") depth++;
    if (c === "}" && --depth === 0) return source.slice(open, i + 1);
  }
  return "";
}

function contractFailures(value) {
  const failures = [];
  const check = (condition, message) => { if (!condition) failures.push(message); };
  const gateRequest = method(value.gate, "public static long RequestVisibility(");
  const gateConsume = method(value.gate, "public static bool TryConsumeVisibilityCompletion(");
  const gatePost = method(value.gate, "public static bool Post(");
  const bridgeComplete = method(value.gate,
    "internal void Complete(WebOverlay.VisibilityOutcome outcome)");
  const awake = method(value.panel, "private void Awake()");
  const begin = method(value.panel, "internal static void BeginCurrentRaid()");
  const update = method(value.panel, "private void Update()");
  const request = method(value.panel, "private void RequestVisibility(");
  const issue = method(value.panel, "private void IssueVisibilityRequest()");
  const retry = method(value.panel, "private void RetryPendingVisibility()");
  const pump = method(value.panel, "private bool PumpOverlayEvents()");
  const reconcile = method(value.panel, "private void ReconcileNativeOverlayState()");
  const completeRequest = method(value.panel, "private void CompleteVisibilityRequest(");
  const destroy = method(value.panel, "private void OnDestroy()");
  const push = method(value.panel, "private void PushStats()");

  check(value.gate.includes('public const string MinimumVersionText = "1.11.0";') &&
      value.gate.includes("new Version(MinimumVersionText)"),
    "gate minimum is not tied to WebOverlay 1.11.0");
  check(value.plugin.includes(
      "[BepInDependency(WebOverlayGate.LibraryGuid, WebOverlayGate.MinimumVersionText)]"),
    "BepInEx hard dependency has no matching minimum version");
  const webOverlayReference = value.project.match(
    /<Reference Include="Anvil-WebOverlay">[\s\S]*?<\/Reference>/)?.[0] ?? "";
  check(webOverlayReference.includes("<Private>false</Private>"),
    "WebOverlay reference is copied into CombatLog output");

  check(value.gate.includes("ConcurrentQueue<OverlayVisibilityCompletion>") &&
      value.gate.includes("VisibilityCompletionBridge") &&
      gateConsume.includes("VisibilityCompletions.TryDequeue"),
    "visibility completions are not transferred through a thread-safe mailbox");
  check(value.gate.includes("Interlocked.Increment(ref _nextVisibilityRequestId)") &&
      gateRequest.includes("handle.Show(completion.Complete)") &&
      gateRequest.includes("handle.Hide(completion.Complete)"),
    "Show/Hide do not use correlated 1.11 completion overloads");
  for (const outcome of ["Applied", "AlreadyThere", "RefusedFullscreen", "Superseded",
                         "Failed", "Disposed", "QueueRefused"]) {
    check(value.gate.includes(`WebOverlay.VisibilityOutcome.${outcome}`) &&
        value.gate.includes(`OverlayVisibilityOutcome.${outcome}`),
      `visibility outcome is not explicitly translated: ${outcome}`);
  }
  check(!/public static[^\n]*(?:WebOverlay\.|VisibilityOutcome)/.test(value.gate),
    "a WebOverlay-owned type escaped through the gate's public surface");
  const failedOutcomeBranch = bridgeComplete.slice(
    bridgeComplete.indexOf("case WebOverlay.VisibilityOutcome.Failed:"),
    bridgeComplete.indexOf("case WebOverlay.VisibilityOutcome.Disposed:"));
  check(failedOutcomeBranch.includes("PublishFailure();"),
    "a non-droppable Failed completion does not latch the gate failure");

  check(gatePost.includes("return handle.TryPost(channel, payload") &&
      !gatePost.includes("handle.Post("),
    "Post still reports handle presence instead of real queue admission");
  check(push.includes("if (WebOverlayGate.Post(") &&
      push.indexOf("_lastPayload = json") > push.indexOf("if (WebOverlayGate.Post("),
    "a refused retained payload can still be marked as sent");

  check(awake.includes("_instance = this") &&
      begin.includes("_instance?.RequestVisibility(false)") &&
      !begin.includes("WebOverlayGate.Hide()"),
    "raid-start Hide has no live panel instance or bypasses its state machine");
  check(request.includes("_awaitingVisibility && _requestedVisible == visible") &&
      request.includes("IssueVisibilityRequest()"),
    "visibility requests are not deduplicated and issued through one path");
  check(issue.includes("WebOverlayGate.RequestVisibility(_requestedVisible)") &&
      issue.includes("_visibilityRequestId = requestId"),
    "panel does not retain the current request identity");
  check(retry.includes("_awaitingVisibility") && retry.includes("_retryVisibility") &&
      retry.includes("IssueVisibilityRequest()"),
    "queue refusal has no bounded later retry path");
  check(update.indexOf("ReconcileNativeOverlayState()") >= 0 &&
      update.indexOf("RetryPendingVisibility()") > update.indexOf("ReconcileNativeOverlayState()") &&
      update.indexOf("PumpOverlayEvents()") > update.indexOf("RetryPendingVisibility()"),
    "Update does not retry at most once before the current frame's pump");
  check(pump.includes("(!_open && !_awaitingVisibility)") &&
      !pump.includes("_visibilityDeadline"),
    "a closed panel can strand a visibility completion or still times it out");
  check(!value.panel.includes("_visibilityDeadline") && !value.panel.includes("Time.unscaledTime + 30f"),
    "the old synthetic visibility deadline remains");
  check(reconcile.includes("completion.RequestId != _visibilityRequestId"),
    "completion reconciliation does not discard stale request ids");
  check(/case OverlayVisibilityOutcome\.Applied:\s*case OverlayVisibilityOutcome\.AlreadyThere:\s*CompleteVisibilityRequest\(completion\.RequestedVisible, reconcileNative: true\);/.test(
      reconcile), "successful outcomes do not settle to the requested/current native state");
  const retryBranch = reconcile.slice(
    reconcile.indexOf("case OverlayVisibilityOutcome.QueueRefused:"),
    reconcile.indexOf("case OverlayVisibilityOutcome.RefusedFullscreen:"));
  check(retryBranch.includes("case OverlayVisibilityOutcome.Superseded:") &&
      retryBranch.includes("_retryVisibility = true") &&
      !retryBranch.includes("CompleteVisibilityRequest("),
    "QueueRefused/Superseded completes instead of preserving the pending retry");
  check(/case OverlayVisibilityOutcome\.RefusedFullscreen:[\s\S]*?CompleteVisibilityRequest\(false\);/.test(
      reconcile) &&
      /case OverlayVisibilityOutcome\.Failed:\s*case OverlayVisibilityOutcome\.Disposed:\s*default:\s*CompleteVisibilityRequest\(false\);/.test(
        reconcile),
    "terminal refusal/failure/disposal outcomes do not settle closed");
  check(completeRequest.includes("reconcileNative && WebOverlayGate.IsCreated") &&
      completeRequest.includes("visible = WebOverlayGate.IsVisible()"),
    "a delayed successful completion can overwrite a newer native transition");
  check(reconcile.indexOf("TryConsumeVisibility(out bool reportedVisible)") <
      reconcile.indexOf("TryConsumeVisibilityCompletion"),
    "the uncorrelated visibility event is not reconciled before completions");
  const eventBranch = reconcile.slice(
    reconcile.indexOf("if (WebOverlayGate.TryConsumeVisibility(out bool reportedVisible))"),
    reconcile.indexOf("while (WebOverlayGate.TryConsumeVisibilityCompletion"));
  check(eventBranch.includes("WebOverlayGate.IsVisible()") &&
      eventBranch.includes(": reportedVisible"),
    "VisibilityChanged payload is trusted instead of being treated as a dirty signal");
  check(reconcile.includes("if (!_awaitingVisibility)\n                    _requestedVisible = visible;") &&
      !reconcile.includes("_awaitingVisibility = false;\n            }\n        }"),
    "VisibilityChanged still completes an outstanding request");
  check(!destroy.includes("Pump()") && !destroy.includes("RequestVisibility("),
    "OnDestroy waits for or creates visibility work");

  check(value.guide.includes("hard 1.11.0 minimum") &&
      value.guide.includes("shutdown deliberately answers `true` while doing nothing") &&
      value.guide.includes("never wait or pump in `OnDestroy`"),
    "maintainer guidance does not describe the new consumer contract");
  return failures;
}

const sourceFailures = contractFailures(sources);
assert(sourceFailures.length === 0, "source contract failed:\n- " + sourceFailures.join("\n- "));
class VisibilityState {
  constructor() {
    this.open = false;
    this.nativeVisible = false;
    this.awaiting = false;
    this.requested = false;
    this.retry = false;
    this.nextId = 0;
    this.activeId = 0;
    this.issued = [];
    this.pendingEvent = undefined;
    this.completions = [];
  }
  request(visible) {
    if (this.awaiting && this.requested === visible) return;
    this.requested = visible;
    this.awaiting = true;
    this.retry = false;
    if (!visible) this.open = false;
    this.issue();
  }
  issue() {
    this.activeId = ++this.nextId;
    this.issued.push({ id: this.activeId, visible: this.requested });
  }
  applyCompletion(id, requestedVisible, outcome) {
    if (!this.awaiting || id !== this.activeId) return;
    if (outcome === "QueueRefused" || outcome === "Superseded") {
      this.retry = true;
      return;
    }
    if (outcome === "Applied" || outcome === "AlreadyThere") {
      this.finish(this.nativeVisible);
      return;
    }
    this.nativeVisible = false;
    this.finish(false);
  }
  applyEvent(visible) {
    if (this.awaiting && visible !== this.requested) this.open = false;
    else {
      this.open = visible;
      if (!this.awaiting) this.requested = visible;
    }
  }
  publishEvent(reportedVisible, nativeVisible = reportedVisible) {
    this.pendingEvent = reportedVisible;
    this.nativeVisible = nativeVisible;
  }
  publishCompletion(id, requestedVisible, outcome, nativeVisible = requestedVisible) {
    this.completions.push({ id, requestedVisible, outcome });
    if (outcome === "Applied" || outcome === "AlreadyThere")
      this.nativeVisible = nativeVisible;
  }
  reconcile() {
    if (this.pendingEvent !== undefined) {
      this.pendingEvent = undefined;
      this.applyEvent(this.nativeVisible);
    }
    while (this.completions.length > 0) {
      const completion = this.completions.shift();
      this.applyCompletion(completion.id, completion.requestedVisible, completion.outcome);
    }
  }
  complete(id, requestedVisible, outcome, nativeVisible = requestedVisible) {
    this.publishCompletion(id, requestedVisible, outcome, nativeVisible);
    this.reconcile();
  }
  event(visible) {
    this.publishEvent(visible);
    this.reconcile();
  }
  nextUpdate() {
    if (!this.awaiting || !this.retry) return;
    this.retry = false;
    this.issue();
  }
  finish(visible) {
    this.open = visible;
    this.requested = visible;
    this.awaiting = false;
    this.retry = false;
  }
  shouldPump() { return this.open || this.awaiting; }
}

{
  const state = new VisibilityState();
  state.request(true);
  const id = state.activeId;
  state.complete(id, true, "Applied");
  state.event(true);
  assert(state.open && !state.awaiting, "first applied Show did not settle open");
}
{
  const state = new VisibilityState();
  state.request(true);
  const showId = state.activeId;
  state.request(false);
  const hideId = state.activeId;
  state.complete(showId, true, "Superseded");
  assert(state.awaiting && !state.retry, "stale Superseded changed the current Hide");
  state.complete(hideId, false, "AlreadyThere");
  assert(!state.open && !state.awaiting, "Hide AlreadyThere did not settle closed");
}
for (const refused of ["QueueRefused", "Superseded"]) {
  const state = new VisibilityState();
  state.request(true);
  const first = state.activeId;
  state.complete(first, true, refused);
  assert(state.awaiting && state.retry && state.issued.length === 1,
    `${refused} completed or retried in the callback`);
  state.nextUpdate();
  assert(state.awaiting && !state.retry && state.activeId !== first && state.issued.length === 2,
    `${refused} did not issue exactly one fresh request next Update`);
  state.nextUpdate();
  assert(state.issued.length === 2, `${refused} retried without another refusal`);
}
{
  const state = new VisibilityState();
  state.request(true);
  const old = state.activeId;
  state.request(false);
  const current = state.activeId;
  state.complete(old, true, "Applied");
  assert(!state.open && state.awaiting, "late pre-raid Show reopened the panel");
  state.complete(current, false, "Applied");
  assert(!state.open && !state.awaiting, "raid-start Hide did not settle");
}
for (const outcome of ["RefusedFullscreen", "Failed", "Disposed"]) {
  const state = new VisibilityState();
  state.request(true);
  state.complete(state.activeId, true, outcome);
  assert(!state.open && !state.awaiting && !state.retry,
    `${outcome} was not a terminal closed result`);
}
{
  const state = new VisibilityState();
  state.request(true);
  state.event(true);
  assert(state.open && state.awaiting, "matching event incorrectly completed Show");
  state.complete(state.activeId, true, "Applied");
  state.event(false);
  assert(!state.open && !state.awaiting && !state.requested,
    "later native close lost to the earlier Show completion");
}
{
  const state = new VisibilityState();
  state.request(true);
  const id = state.activeId;
  state.publishEvent(false, false);
  state.publishCompletion(id, true, "Applied", true);
  state.reconcile();
  assert(state.open && !state.awaiting,
    "an older event payload overwrote the current applied Show state");
}
{
  const state = new VisibilityState();
  state.request(true);
  const id = state.activeId;
  state.publishEvent(true, true);
  state.publishCompletion(id, true, "Applied", false);
  state.reconcile();
  assert(!state.open && !state.awaiting,
    "an older event payload resurrected a natively closed window");
}
{
  const state = new VisibilityState();
  state.request(true);
  const id = state.activeId;
  state.event(false);
  state.complete(id, true, "Applied", true);
  assert(state.open && !state.awaiting,
    "current native snapshot did not win over an older delivered event");
}
{
  const state = new VisibilityState();
  state.open = true;
  state.request(false);
  assert(!state.open && state.awaiting && state.shouldPump(),
    "closed optimistic state stranded the pending Hide completion");
}
function swapVisibilityMailboxOrder(panel) {
  const body = method(panel, "private void ReconcileNativeOverlayState()");
  const eventStart = body.indexOf(
    "        if (WebOverlayGate.TryConsumeVisibility(out bool reportedVisible))");
  const completionStart = body.indexOf(
    "        while (WebOverlayGate.TryConsumeVisibilityCompletion");
  const failureStart = body.indexOf(
    "        if (WebOverlayGate.ConsumeFailureWarning())");
  if (eventStart < 0 || completionStart < 0 || failureStart < 0) return panel;

  const swapped = body.slice(0, eventStart) +
    body.slice(completionStart, failureStart) +
    body.slice(eventStart, completionStart) +
    body.slice(failureStart);
  return panel.replace(body, swapped);
}

const mutants = [
  ["unversioned dependency", { ...sources, plugin: sources.plugin.replace(
    ", WebOverlayGate.MinimumVersionText", "") }],
  ["old API floor", { ...sources, gate: sources.gate.replace(
    'MinimumVersionText = "1.11.0"', 'MinimumVersionText = "1.10.0"') }],
  ["WebOverlay dependency copied", { ...sources, project: sources.project.replace(
    /(<Reference Include="Anvil-WebOverlay">[\s\S]*?)<Private>false<\/Private>/,
    "$1") }],
  ["pretend post success", { ...sources, gate: sources.gate.replace(
    "return handle.TryPost(channel, payload, retain", "handle.Post(channel, payload, retain")
      .replace("            : WebOverlay.PostOptions.LatestOnly);\n    }",
        "            : WebOverlay.PostOptions.LatestOnly);\n        return true;\n    }") }],
  ["direct raid hide", { ...sources, panel: sources.panel.replace(
    "_instance?.RequestVisibility(false);", "WebOverlayGate.Hide();") }],
  ["missing panel instance", { ...sources, panel: sources.panel.replace(
    "_instance = this;", "") }],
  ["failed completion not latched", { ...sources, gate: sources.gate.replace(
    "                    PublishFailure();\n", "") }],
  ["successful result forced closed", { ...sources, panel: sources.panel.replace(
    "CompleteVisibilityRequest(completion.RequestedVisible, reconcileNative: true);",
    "CompleteVisibilityRequest(false);") }],
  ["retry prematurely completed", { ...sources, panel: sources.panel.replace(
    "                    _retryVisibility = true;",
    "                    CompleteVisibilityRequest(false);\n                    _retryVisibility = true;") }],
  ["native snapshot removed", { ...sources, panel: sources.panel.replace(
    "            visible = WebOverlayGate.IsVisible();", "") }],
  ["event payload trusted", { ...sources, panel: sources.panel.replace(
    "? WebOverlayGate.IsVisible()\n                : reportedVisible;",
    "? reportedVisible\n                : reportedVisible;") }],
  ["event processed after completion", {
    ...sources,
    panel: swapVisibilityMailboxOrder(sources.panel),
  }],
  ["deadline restored", { ...sources, panel: sources.panel.replace(
    "private bool _retryVisibility;", "private bool _retryVisibility;\n    private float _visibilityDeadline;") }],
  ["event completes request", { ...sources, panel: sources.panel.replace(
    "if (!_awaitingVisibility)\n                    _requestedVisible = visible;",
    "_requestedVisible = visible;\n                _awaitingVisibility = false;") }],
];
for (const [name, mutant] of mutants) {
  assert(contractFailures(mutant).length > 0, `mutant control escaped: ${name}`);
}

console.log("COMBATLOG WEBOVERLAY 1.11 INTEGRATION VERIFIED");
