export type SearchMode = "hybrid" | "bm25" | "vector";

export interface ObsidianKbSettings {
  executablePath: string;
  configPath: string;
  indexDir: string;
  host: string;
  port: number;
  vaultPath: string;
  autoStart: boolean;
  preloadEmbedder: boolean;
  idleUnloadSeconds: number;
  defaultMode: SearchMode;
  defaultTop: number;
  includeText: boolean;
  maxChars: number;
  expandGraph: boolean;
  indexExcludeHeadings: string[];
  indexPdfEnabled: boolean;
  indexPdfMaxFileSizeMb: number;
  searchBm25Candidates: number;
  searchVectorCandidates: number;
  searchGraphWeight: number;
  searchGraphDepth: number;
  searchGraphMaxNeighbors: number;
}

export const DEFAULT_SETTINGS: ObsidianKbSettings = {
  executablePath: "obsidian-kb",
  configPath: "",
  indexDir: "",
  host: "127.0.0.1",
  port: 27124,
  vaultPath: "",
  autoStart: true,
  preloadEmbedder: false,
  idleUnloadSeconds: 600,
  defaultMode: "hybrid",
  defaultTop: 10,
  includeText: false,
  maxChars: 1200,
  expandGraph: true,
  indexExcludeHeadings: [],
  indexPdfEnabled: false,
  indexPdfMaxFileSizeMb: 50,
  searchBm25Candidates: 80,
  searchVectorCandidates: 80,
  searchGraphWeight: 0.25,
  searchGraphDepth: 1,
  searchGraphMaxNeighbors: 20,
};

export interface KbHealth {
  ok: boolean;
  version?: string;
}

export interface KbStatus {
  ok: boolean;
  version?: string;
  vault_path?: string;
  index?: {
    available?: boolean;
    error?: string | null;
    stats?: KbStats | null;
  };
  mcp?: {
    vector_embedder_loaded?: boolean;
    vector_embeddings_loaded?: boolean;
    vector_embedding_count?: number;
    idle_unload_seconds?: number;
  };
}

export interface KbStats {
  notes?: number;
  chunks?: number;
  links?: number;
  embeddings?: number;
  [key: string]: unknown;
}

export interface KbSearchRequest {
  query: string;
  mode: SearchMode;
  top: number;
  expand_graph: boolean;
  include_text: boolean;
  max_chars: number;
  tags?: string[];
  properties?: string[];
}

export interface KbSearchHit {
  path?: string;
  note_path?: string;
  document_kind?: string;
  title?: string;
  heading_path?: string;
  heading?: string;
  best_chunk_id?: string;
  best_heading?: string;
  best_start_line?: number;
  best_end_line?: number;
  best_start_page?: number;
  best_end_page?: number;
  best_snippet?: string;
  line_start?: number;
  line_end?: number;
  start_line?: number;
  end_line?: number;
  start_page?: number;
  end_page?: number;
  snippet?: string;
  text?: string;
  chunk_id?: string;
  final_score?: number;
  score?: number;
  rank?: number;
  tags?: string[];
  chunks?: KbSearchHit[];
  [key: string]: unknown;
}

export interface RelatedNote {
  path?: string;
  note_path?: string;
  document_kind?: string;
  title?: string;
  score?: number;
  best_score?: number;
  best_chunk_id?: string;
  best_heading?: string;
  start_page?: number;
  end_page?: number;
  chunks?: KbSearchHit[];
  [key: string]: unknown;
}

export interface RelatedReport {
  source?: {
    kind?: string;
    path?: string;
    title?: string;
    [key: string]: unknown;
  };
  notes?: RelatedNote[];
  [key: string]: unknown;
}

export interface KbChunkRecord {
  chunk_id: string;
  note_path: string;
  document_kind?: string;
  title?: string;
  heading_path?: string;
  text: string;
  start_line?: number;
  end_line?: number;
  start_page?: number;
  end_page?: number;
  tags?: string[];
  [key: string]: unknown;
}

export type ServiceState =
  | "unknown"
  | "stopped"
  | "starting"
  | "ready"
  | "error";
