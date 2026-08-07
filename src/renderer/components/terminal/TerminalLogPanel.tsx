import { useEffect, useRef } from 'react';

interface TerminalLogPanelProps {
  chunks: string[];
  className?: string;
}

export const TerminalLogPanel = ({
  chunks,
  className,
}: TerminalLogPanelProps): React.JSX.Element => {
  const preRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    if (preRef.current) {
      preRef.current.scrollTop = preRef.current.scrollHeight;
    }
  }, [chunks]);

  return (
    <pre
      ref={preRef}
      className={`mt-2 overflow-auto rounded border p-2 text-xs ${className ?? ''}`}
      style={{
        backgroundColor: '#141416',
        color: '#fafafa',
        borderColor: 'var(--color-border)',
        height: '120px',
        fontFamily: 'Menlo, Monaco, "Courier New", monospace',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-all',
      }}
    >
      {chunks.join('')}
    </pre>
  );
};
