import React from 'react';

interface RepeatProps {
  /** Number of times to invoke `render`. */
  count: number;
  /** Renders one item; receives its zero-based index (used as the React key). */
  render: (index: number) => React.ReactNode;
}

/**
 * Renders `render(i)` `count` times with a stable index key. Factors out the
 * `Array.from({ length: count }).map(...)` loop shared by the skeleton list
 * wrappers. The leaf shape components stay 1:1 with their real counterparts —
 * this only owns the count-loop.
 */
export const Repeat: React.FC<RepeatProps> = ({ count, render }) => {
  return (
    <>
      {Array.from({ length: count }).map((_, index) => (
        <React.Fragment key={index}>{render(index)}</React.Fragment>
      ))}
    </>
  );
};
