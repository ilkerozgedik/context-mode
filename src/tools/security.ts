import {
  evaluateFilePath,
  evaluateProjectContainment,
  readToolDenyPatterns,
  readToolPermissionPatterns,
} from "../security.js";
import { getProjectDir } from "../project-context.js";

export type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

function securityCheckFailed(): ToolResult {
  return {
    content: [{ type: "text", text: "Security policy check failed; request blocked." }],
    isError: true,
  };
}

export function checkProjectBoundary(filePath: string, toolName: string): ToolResult | null {
  try {
    const projectDir = getProjectDir();
    const allowGlobs = readToolPermissionPatterns("Read", "allow", projectDir);
    const verdict = evaluateProjectContainment(filePath, projectDir, allowGlobs);
    if (verdict.allowed) return null;
    return {
      content: [{
        type: "text",
        text:
          `File access blocked: "${filePath}" resolves outside the project root ` +
          `(${projectDir}). The ${toolName} path argument is workspace-scoped. ` +
          `To intentionally select a file outside the project, add a host allow rule, ` +
          `e.g. "permissions": { "allow": ["Read(${filePath})"] } in your settings.`,
      }],
      isError: true,
    };
  } catch {
    return securityCheckFailed();
  }
}

export function checkFilePathDenyPolicy(filePath: string): ToolResult | null {
  try {
    const projectDir = getProjectDir();
    const denyGlobs = readToolDenyPatterns("Read", projectDir);
    const result = evaluateFilePath(filePath, denyGlobs, (process.platform === "win32" || process.platform === "darwin"), projectDir);
    if (result.denied) {
      return {
        content: [{
          type: "text",
          text: `File access blocked by security policy: path matches Read deny pattern ${result.matchedPattern}`,
        }],
        isError: true,
      };
    }
  } catch {
    return securityCheckFailed();
  }
  return null;
}

export function createPerFileReadDeny(projectDir: string): (absolutePath: string) => boolean {
  const denyGlobs = readToolDenyPatterns("Read", projectDir);
  const caseInsensitive = process.platform === "win32" || process.platform === "darwin";
  return (absolutePath: string): boolean => {
    try {
      return evaluateFilePath(absolutePath, denyGlobs, caseInsensitive, projectDir).denied;
    } catch {
      return false;
    }
  };
}
