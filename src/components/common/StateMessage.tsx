interface StateMessageProps {
  title: string;
  body?: string;
  className?: string;
}

export default function StateMessage({ title, body, className = '' }: StateMessageProps) {
  return (
    <div className={`flex flex-col items-center justify-center gap-2 px-6 py-10 text-center ${className}`.trim()}>
      <p className="text-sm font-medium text-text-primary">{title}</p>
      {body && (
        <p className="max-w-md text-sm text-text-muted">{body}</p>
      )}
    </div>
  );
}
