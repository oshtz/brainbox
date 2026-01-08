import React from 'react';
import styles from './Grid.module.css';

const Grid = ({ children, className = '', gap = 'md', ...props }) => {
  const gridClasses = `${styles.grid} ${className}`.trim();
  
  // Use CSS variable for gap, maps 'sm', 'md', 'lg' to var(--space-sm), etc.
  const gridStyle = {
    '--grid-gap': `var(--space-${gap}, var(--space-md))`
  };

  return (
    <div className={gridClasses} style={gridStyle} {...props}>
      {children}
    </div>
  );
};

export default Grid;
