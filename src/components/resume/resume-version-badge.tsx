export type ResumeVersionBinding = {
  resume_version_id?: number | null;
  resume_version?: number | null;
  resume_version_name?: string | null;
};

export function ResumeVersionBadge({ resume_version_id, resume_version, resume_version_name }: ResumeVersionBinding) {
  if (!resume_version_id && !resume_version) return null;
  return <span className="inline-flex max-w-full items-center rounded-full bg-primary-soft px-2 py-0.5 text-xs font-medium text-primary" title={resume_version_name || "已绑定的简历发布版本"}>
    <span className="truncate">{resume_version ? `v${resume_version}` : `版本 #${resume_version_id}`}{resume_version_name ? ` · ${resume_version_name}` : ""}</span>
  </span>;
}
