import { buildMediaPayload } from "simpleclaw/plugin-sdk";

export function buildMSTeamsMediaPayload(
  mediaList: Array<{ path: string; contentType?: string }>,
): {
  MediaPath?: string;
  MediaType?: string;
  MediaUrl?: string;
  MediaPaths?: string[];
  MediaUrls?: string[];
  MediaTypes?: string[];
} {
  return buildMediaPayload(mediaList, { preserveMediaTypeCardinality: true });
}
