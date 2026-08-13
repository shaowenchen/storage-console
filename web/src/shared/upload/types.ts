export type UploadFileMeta = {
  name: string;
  size: number;
  contentType: string;
};

export type UploadLink = {
  name: string;
  key: string;
  size: number;
  contentType: string;
  url: string;
  headers?: Record<string, string>;
};

export type UploadLinksResponse = {
  uploads: UploadLink[];
  expiresInSeconds?: number;
};

export type CompletedUpload = {
  key: string;
  name: string;
  size: number;
  contentType: string;
  relativePath?: string;
};

export type StorageUploadContext = {
  mode: 'storage';
  bucketId: string;
  relativePath?: string;
};

export type UploadProgress = {
  percent: number;
  message: string;
};
