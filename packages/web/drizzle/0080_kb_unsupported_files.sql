CREATE TABLE "kb_unsupported_files" (
	"org_id" text NOT NULL,
	"source_path" text NOT NULL,
	"file_type" text NOT NULL,
	"seen_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "kb_unsupported_files_org_id_source_path_pk" PRIMARY KEY("org_id","source_path")
);
