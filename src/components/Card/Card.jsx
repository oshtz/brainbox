import React from 'react';
import styles from './Card.module.css';

const Card = ({ children, className = '', ...props }) => {
  const cardClasses = `${styles.card} ${className}`.trim();

  return (
    <div className={cardClasses} {...props}>
      {children}
    </div>
  );
};

export default Card;
