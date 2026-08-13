export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  backgrounded?: boolean;
}

export interface IndexResult {
  sourceId: number;
  label: string;
  totalChunks: number;
  codeChunks: number;
}

export interface SearchResult {
  title: string;
  content: string;
  source: string;
  rank: number;
  contentType: "code" | "prose";
  matchLayer?: "porter" | "trigram" | "fuzzy" | "rrf" | "rrf-fuzzy";
  highlighted?: string;
  timestamp?: string;
}
