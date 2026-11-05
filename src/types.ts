import type { AnalysisResponse, Profile, Schema, VisualizeResponse } from '@antv/ava';
import type { InlineChart } from './charts.js';

export type DatasetSource =
  | { kind: 'file'; path: string; name: string }
  | { kind: 'bitable'; url: string; name: string; appId: string; appSecret: string };

export interface DatasetInfo {
  name: string;
  schema: Schema;
  profile: Profile;
  previews: { table: string; rows: Record<string, unknown>[] }[];
}

export interface AnalysisOutput {
  result: AnalysisResponse;
  visualization: VisualizeResponse | null;
  charts?: InlineChart[];
  chartWarning?: string;
}

export interface MessageEvent {
  sender: { sender_type: string; sender_id?: { open_id?: string } };
  message: {
    message_id: string;
    chat_id: string;
    chat_type: string;
    message_type: string;
    content: string;
    mentions?: { key: string; id: { open_id?: string } }[];
  };
}

export interface IncomingMessage {
  id: string;
  chatId: string;
  userId: string;
  sessionKey: string;
  file?: { key: string; name: string };
  attachmentCount?: number;
  text?: string;
}
