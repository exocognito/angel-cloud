export const headingSlugs = (markdown: string, maxDepth = 6): Set<string> => {
  const slugs = new Set<string>();
  const headingPattern = new RegExp(`^#{1,${maxDepth}}\\s+(.*)$`);
  let fence: "```" | "~~~" | undefined;
  for (const line of markdown.split("\n")) {
    const fenceMarker = line.match(/^\s*(```|~~~)/)?.[1] as "```" | "~~~" | undefined;
    if (fenceMarker) {
      if (!fence) fence = fenceMarker;
      else if (fence === fenceMarker) fence = undefined;
      continue;
    }
    if (fence) continue;
    const heading = line.match(headingPattern)?.[1];
    if (!heading) continue;
    const text = heading
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/[`*]/g, "")
      .replace(/\b_([^_]+)_\b/g, "$1");
    const base = text.trim().toLowerCase().replace(/[^\w\- ]+/g, "").replace(/ /g, "-");
    let slug = base;
    let suffix = 0;
    while (slugs.has(slug)) slug = `${base}-${++suffix}`;
    slugs.add(slug);
  }
  return slugs;
};
