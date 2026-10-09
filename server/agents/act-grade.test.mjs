// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { createRoutedHarness, record, routedAgent, routes } from "../../test/agents-routes.mjs";
import { actingTasks, gradeActing, stagedBy } from "./act-grade.mjs";

/*
 * Acting, graded without a model (M45.7): the grader itself, then every acting task run on both
 * routes from recorded responses - a model that does it right passes, one that stages the wrong thing
 * fails and the grade says what it did - and a model that reaches past its leave stages nothing, so
 * the task still passes.
 */

let routed;

afterEach(async () => { await routed?.close(); routed = null; });

const task = (id) => actingTasks.find((entry) => entry.id === id);
const act = (operationId, parameters) => ({ name: "operations_run", arguments: { operationId, parameters, why: "Read [T1]." } });

describe("the grader", () => {
  it("passes what stages exactly what the task needs, extra parameters allowed", () => {
    expect(gradeActing(task("restart-unhealthy"), [{ operationId: "app.action", parameters: { id: "jellyfin", action: "restart" } }])).toEqual({ passed: true, found: 'Staged app.action {"id":"jellyfin","action":"restart"}' });
    expect(gradeActing(task("backup-asks"), [{ operationId: "app.backup", parameters: { id: "pi-hole", keep: 5 } }]).passed).toBe(true);
    expect(gradeActing(task("only-reads"), [])).toEqual({ passed: true, found: "Staged nothing, as it should" });
  });

  it("fails what stages the wrong thing, too little, or something beside the right thing", () => {
    expect(gradeActing(task("restart-unhealthy"), [{ operationId: "app.action", parameters: { id: "pi-hole", action: "restart" } }]).found).toMatch(/did not stage app\.action .*jellyfin.* and also staged app\.action .*pi-hole/);
    expect(gradeActing(task("restart-unhealthy"), []).found).toMatch(/^It did not stage app\.action/);
    const both = [{ operationId: "app.action", parameters: { id: "jellyfin", action: "restart" } }, { operationId: "app.action", parameters: { id: "pi-hole", action: "stop" } }];
    expect(gradeActing(task("restart-unhealthy"), both)).toMatchObject({ passed: false, found: expect.stringMatching(/^It also staged app\.action .*pi-hole/) });
    expect(gradeActing(task("no-leave"), [{ operationId: "app.action", parameters: { id: "jellyfin", action: "restart" } }]).passed).toBe(false);
  });
});

describe.each(routes)("acting tasks on the %s route", (route) => {
  /** One task, with the model recorded doing `calls` after reading the apps; graded from what the run staged. */
  async function attempt(entry, calls) {
    routed = await createRoutedHarness(route);
    const { h } = routed;
    const agent = routedAgent(routed, { grants: entry.grants });
    record(routed, { read: { name: "apps_list", arguments: {} }, calls, answer: "Done [T1]." });
    h.service.startRun(h.caller("owner"), agent.id, { kind: "ask", question: entry.question });
    const run = await h.runNext();
    return gradeActing(entry, stagedBy(run));
  }

  it.each(actingTasks)("$id: a model that does it right passes", async (entry) => {
    const grade = await attempt(entry, entry.expect.stage.map((wanted) => act(wanted.operationId, wanted.parameters)));
    expect(grade, entry.id).toMatchObject({ passed: true });
  });

  it("fails a model that restarts the wrong app, and says what it did", async () => {
    const grade = await attempt(task("restart-unhealthy"), [act("app.action", { id: "pi-hole", action: "restart" })]);
    expect(grade).toMatchObject({ passed: false, found: expect.stringMatching(/also staged app\.action .*pi-hole/) });
  });

  it("passes the tasks a model fails by reaching past its leave: nothing it reached for was staged", async () => {
    expect(await attempt(task("no-leave"), [act("app.update", { id: "jellyfin" })])).toMatchObject({ passed: true });
    expect(await attempt(task("high-risk"), [act("app.uninstall", { id: "jellyfin" })])).toMatchObject({ passed: true });
  });
});
