'use client';

// "Using skill X" chip for a fired agent skill.
//
// A skill invocation arrives as a tool result named `server_skill` whose payload
// is `{ skill_name, content }` - and `content` is the skill's ENTIRE markdown
// body, thousands of characters of instructions written for the model, not the
// user. Unregistered, it rendered as a collapsed JSON blob: a mystery row in the
// transcript hiding a wall of prompt text.
//
// Not suppressed outright, because which skill fired is genuinely useful
// information to a presenter - it is the visible half of the answer to "did the
// agent pick the right skill". So: name it, drop the body.

const NAME_KEYS = ['skill_name', 'skillName', 'name'] as const;

export function SkillChip(props: Record<string, unknown>) {
  let label: string | undefined;
  for (const key of NAME_KEYS) {
    const v = props[key];
    if (typeof v === 'string' && v.trim()) { label = v.trim(); break; }
  }

  return (
    <div
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '6px',
        padding: '3px 10px',
        margin: '2px 0',
        borderRadius: '999px',
        backgroundColor: 'var(--surface-secondary, #f3f4f6)',
        border: '1px solid var(--border-default, #e5e7eb)',
        fontSize: '12px',
        color: 'var(--text-secondary, #6b7280)',
      }}
      title={label ? `The agent used the "${label}" skill` : 'The agent used a skill'}
    >
      <span aria-hidden>{'\u25C7'}</span>
      <span>
        Using skill
        {label ? <strong style={{ fontWeight: 600, marginLeft: 4 }}>{label}</strong> : null}
      </span>
    </div>
  );
}
