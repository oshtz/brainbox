import React from 'react';
import { CardProps } from '../../types';
import styles from './Card.module.css';

const Card: React.FC<CardProps> = ({ children, className = '', ...props }) => {
  const cardClasses = `${styles.card} ${className}`.trim();

  return (
    <div className={cardClasses} {...props}>
      {children}
    </div>
  );
};

export default Card;