// Helper for tests/ubuntu/name-lookups.sh: one step, one JSON line out.
//
//   node name-lookups.mjs inspect <server-dir>   Repair's reading and finding, as the web service makes them
//   node name-lookups.mjs restore <server-dir>   the fix, through boxpilot-run@ as the helper runs it
const [, , step, serverDir = "/opt/boxpilot/server"] = process.argv;

if (step === "inspect") {
  const { inspectNameLookups, nameLookupVerdict } = await import(`${serverDir}/name-lookups.mjs`);
  const { detectRemediations } = await import(`${serverDir}/remediations.mjs`);
  const facts = await inspectNameLookups();
  const { findings } = detectRemediations({ nameLookups: facts, hostname: "homebox" });
  const found = findings.find((finding) => finding.id === "name-lookups") ?? null;
  console.log(JSON.stringify({ uid: process.getuid(), facts, verdict: nameLookupVerdict(facts), finding: found, findings: findings.map((finding) => finding.id) }));
} else if (step === "restore") {
  const { createRunUnitClient } = await import(`${serverDir}/run-unit.mjs`);
  try {
    const result = await createRunUnitClient().runTask("dns.lookups-restore", {}, { timeoutMs: 90_000 });
    console.log(JSON.stringify({ ok: true, result }));
  } catch (error) {
    console.log(JSON.stringify({ ok: false, error: error.message }));
  }
} else {
  console.error("usage: name-lookups.mjs inspect|restore <server-dir>");
  process.exit(2);
}
