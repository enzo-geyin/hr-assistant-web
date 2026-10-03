const resolveMammoth = mod => {
  const candidates = [mod, mod?.default, mod?.mammoth, mod?.default?.mammoth, globalThis?.mammoth];
  return candidates.find(candidate => typeof candidate?.extractRawText === "function") || null;
};

export const extractDocxRawText = async file => {
  const mod = await import("mammoth/mammoth.browser").catch(() => null);
  const mammoth = resolveMammoth(mod);
  if (!mammoth) throw new Error("Word 解析组件加载失败，请改用 PDF、图片或纯文本 JD");
  const result = await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
  return result?.value || "";
};
