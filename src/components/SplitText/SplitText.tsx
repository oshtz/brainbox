import React, { useEffect, useState } from 'react';
import styles from './SplitText.module.css';

interface SplitTextProps {
    text?: string;
    className?: string;
    delay?: number;
    animationFrom?: { opacity: number; transform: string };
    animationTo?: { opacity: number; transform: string };
    easing?: (t: number) => number;
    threshold?: number;
    rootMargin?: string;
    textAlign?: 'left' | 'right' | 'center' | 'justify' | 'initial' | 'inherit';
    onLetterAnimationComplete?: () => void;
    trigger?: 'mount' | 'intersection';
    letterClassName?: string;
}

/**
 * Optimized SplitText component using CSS animations instead of React Spring
 * for better performance on macOS WebKit while preserving the beautiful letter-by-letter effect
 */
const SplitText: React.FC<SplitTextProps> = ({
    text = '',
    className = '',
    delay = 50,
    textAlign = 'center',
    onLetterAnimationComplete,
}) => {
    const [isVisible, setIsVisible] = useState(false);
    const words = text.split(' ').map(word => word.split(''));
    const letters = words.flat();

    useEffect(() => {
        // Reset animation state when text changes
        setIsVisible(false);
        const timer = setTimeout(() => {
            setIsVisible(true);
            // Call completion callback after all letters finish animating
            if (onLetterAnimationComplete) {
                const totalDelay = letters.length * delay + 300; // animation duration
                setTimeout(onLetterAnimationComplete, totalDelay);
            }
        }, 50);
        
        return () => clearTimeout(timer);
    }, [text, onLetterAnimationComplete, letters.length, delay]);

    return (
        <p
            className={`${styles.splitParent} ${className}`}
            style={{
                textAlign,
                display: 'inline',
                whiteSpace: 'normal',
                wordWrap: 'break-word'
            }}
        >
            {words.map((word, wordIndex) => (
                <span key={`${text}-${wordIndex}`} className={styles.word}>
                    {word.map((letter, letterIndex) => {
                        const globalIndex = words.slice(0, wordIndex).reduce((acc, w) => acc + w.length, 0) + letterIndex;
                        return (
                            <span
                                key={`${text}-${globalIndex}`}
                                className={`${styles.letter} ${isVisible ? styles.letterVisible : ''}`}
                                style={{
                                    animationDelay: `${globalIndex * delay}ms`
                                }}
                            >
                                {letter}
                            </span>
                        );
                    })}
                    <span className={styles.space}>&nbsp;</span>
                </span>
            ))}
        </p>
    );
};

export default SplitText;
