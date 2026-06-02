import { ApiError } from "@/lib/api-client";
import { draftIdSchema, uploadResponseSchema, type UploadResponse } from "@/lib/schemas/uploads";

/**
 * Upload a file attachment to the server using XMLHttpRequest so that upload
 * progress events are available (fetch does not expose upload progress).
 *
 * @param agentId  - The agent this upload is associated with.
 * @param draftId  - Draft ID sent as the `x-pinchy-draft-id` request header.
 * @param file     - The File to upload.
 * @param onProgress - Optional callback receiving upload progress as a 0–100 percent value.
 * @param signal   - Optional AbortSignal — when it fires, `xhr.abort()` is called and the
 *                   promise rejects with `ApiError(0, "Upload cancelled.")`. An already-aborted
 *                   signal causes the promise to reject without ever sending the request.
 * @returns Parsed `UploadResponse` from the server on a 201 response.
 * @throws {ApiError} on non-2xx responses, network errors, or cancellation.
 */
export async function uploadAttachment(
  agentId: string,
  draftId: string,
  file: File,
  onProgress?: (percent: number) => void,
  signal?: AbortSignal
): Promise<UploadResponse> {
  if (!draftIdSchema.safeParse(draftId).success) {
    throw new ApiError(0, "Invalid draft ID");
  }

  if (signal?.aborted) {
    throw new ApiError(0, "Upload cancelled.");
  }

  return new Promise<UploadResponse>((resolve, reject) => {
    const xhr = new XMLHttpRequest();

    xhr.timeout = 120_000;
    xhr.ontimeout = () => {
      reject(new ApiError(0, "Upload timed out. Please try again."));
    };

    xhr.onabort = () => {
      reject(new ApiError(0, "Upload cancelled."));
    };

    if (signal) {
      // External cancel: caller removed the pending upload before XHR settled
      // (PinchyAttachmentChip × button → removePendingUpload). Bail out of the
      // in-flight upload so the server's staged row is the only artifact, and
      // the GC reclaims it at expiry.
      signal.addEventListener("abort", () => xhr.abort(), { once: true });
    }

    xhr.open("POST", `/api/agents/${agentId}/uploads`);
    xhr.setRequestHeader("x-pinchy-draft-id", draftId);

    if (onProgress) {
      xhr.upload.onprogress = (event: ProgressEvent) => {
        if (event.lengthComputable) {
          onProgress(Math.min(100, Math.round((event.loaded / event.total) * 100)));
        }
      };
    }

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        let body: unknown;
        try {
          body = JSON.parse(xhr.responseText);
        } catch {
          reject(new ApiError(xhr.status, "Invalid response from server"));
          return;
        }
        const parsed = uploadResponseSchema.safeParse(body);
        if (!parsed.success) {
          reject(new ApiError(xhr.status, "Invalid response shape from server"));
          return;
        }
        resolve(parsed.data);
      } else {
        let errMessage = "Something went wrong. Please try again.";
        try {
          const errBody = JSON.parse(xhr.responseText) as { error?: string };
          if (errBody.error) {
            errMessage = errBody.error;
          }
        } catch {
          // leave fallback message
        }
        reject(new ApiError(xhr.status, errMessage));
      }
    };

    xhr.onerror = () => {
      reject(new ApiError(0, "Network error. Please check your connection."));
    };

    const formData = new FormData();
    formData.append("file", file);
    xhr.send(formData);
  });
}
