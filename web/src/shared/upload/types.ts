/** Response to starting a chunked upload (POST /storages/:id/upload-multipart). */
export type UploadSessionResponse = {
  uploadToken: string;
  key: string;
  name: string;
  size: number;
  contentType: string;
  relativePath: string;
  /** Maximum bytes per part; the client slices to this. */
  partSize: number;
  partCount: number;
};

/** One part's receipt, fed back at completion. */
export type UploadedPart = {
  partNumber: number;
  etag: string;
  size: number;
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

/** Server-side upload constraints (see GET /storages/upload-limits). */
export type UploadLimits = {
  maxFiles: number;
  maxBytes: number;
};
