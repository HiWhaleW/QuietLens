const MAX_INPUT_LENGTH = 1200;

const BLOCKED_INSTRUCTION_PATTERNS = [
  /忽略(?:所有|系统)?规则|ignore (?:all |the )?(?:system )?(?:rules|instructions)/i,
  /泄露(?:系统提示词|环境变量)|reveal (?:the )?(?:system prompt|environment variables)/i,
  /(?:file|https?):\/\/[^\s]+.*(?:读取|隐藏证据)|读取.*file:\/\//i,
  /(?:永久记住|长期保存).*(?:家庭地址|住址|精确地址)/i,
  /(?:未经确认|用户评论|到店反馈).*(?:直接|立刻).*(?:事实|入库)/i,
  /(?:偷偷|强行).*(?:第十一家|范围外|白名单)/i,
  /(?:未授权工具|覆盖候选白名单)/i,
  /(?:ADHD|自闭症|疾病).*(?:治疗|诊断)/i,
  /第三方.*(?:原图|摄影作品).*(?:发布|上传)/i,
];

export function preprocessUserInput(value) {
  if (typeof value !== "string") {
    return { valid: false, error_code: "INPUT_TYPE_INVALID", text: null };
  }

  const text = value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim();
  if (!text) return { valid: false, error_code: "INPUT_EMPTY", text: null };
  if (text.length > MAX_INPUT_LENGTH) {
    return { valid: false, error_code: "INPUT_TOO_LONG", text: null };
  }
  if (BLOCKED_INSTRUCTION_PATTERNS.some((pattern) => pattern.test(text))) {
    return { valid: false, error_code: "UNTRUSTED_INSTRUCTION_BLOCKED", text: null };
  }

  return { valid: true, error_code: null, text };
}

