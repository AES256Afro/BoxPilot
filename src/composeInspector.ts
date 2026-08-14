export interface ComposeInspection {
  services: number;
  publishedPorts: number;
  volumeMounts: number;
  risks: string[];
}

export function inspectCompose(source: string): ComposeInspection {
  const lines = source.replace(/\r/g, "").split("\n");
  let inServices = false;
  let services = 0;
  let publishedPorts = 0;
  let volumeMounts = 0;

  for (const line of lines) {
    if (/^services:\s*(?:#.*)?$/.test(line)) {
      inServices = true;
      continue;
    }

    if (inServices && /^\S[^:]*:\s*(?:#.*)?$/.test(line)) {
      inServices = false;
    }

    if (inServices && /^ {2}[a-zA-Z0-9_.-]+:\s*(?:#.*)?$/.test(line)) {
      services += 1;
    }

    if (/^\s*-\s*["']?(?:(?:\d{1,3}\.){3}\d{1,3}:)?(?:\d{1,5}:)?\d{1,5}(?:\/\w+)?["']?\s*(?:#.*)?$/.test(line)) {
      publishedPorts += 1;
    }

    if (/^\s*-\s*[^#\n]+:[^#\n]+/.test(line) && !/^\s*-\s*["']?\d/.test(line)) {
      volumeMounts += 1;
    }
  }

  const risks: string[] = [];
  if (/privileged:\s*true/i.test(source)) {
    risks.push("Privileged container requested");
  }
  if (/\/var\/run\/docker\.sock/.test(source)) {
    risks.push("Docker socket mounted");
  }
  if (/network_mode:\s*["']?host/i.test(source)) {
    risks.push("Host networking requested");
  }
  if (/^\s*-\s*["']?\/:/m.test(source)) {
    risks.push("Host root filesystem mounted");
  }

  return { services, publishedPorts, volumeMounts, risks };
}
