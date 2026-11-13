export function processIdentityContainsPath(identity: string, target: string, platform: string) {
  const normalize = (value: string) => {
    const separators = value.replace(/\\/gu, "/");
    return platform === "win32" ? separators.toLowerCase() : separators;
  };
  const command = normalize(identity);
  const root = normalize(target).replace(/\/+$/u, "");
  if (!root) return false;

  // macOS tools may report the physical path for /var, /tmp and /etc.
  const candidates = [root];
  if (platform === "darwin") {
    if (/^\/(?:var|tmp|etc)(?:\/|$)/u.test(root)) {
      candidates.push(`/private${root}`);
    } else if (/^\/private\/(?:var|tmp|etc)(?:\/|$)/u.test(root)) {
      candidates.push(root.slice("/private".length));
    }
  }
  for (const candidate of candidates) {
    let index = command.indexOf(candidate);
    while (index !== -1) {
      const before = command[index - 1];
      const after = command[index + candidate.length];
      if ((!before || /[\s"'=]/u.test(before)) && (!after || /[\s"'/]/u.test(after))) {
        return true;
      }
      index = command.indexOf(candidate, index + candidate.length);
    }
  }
  return false;
}
