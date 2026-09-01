export default function HaloMark({ className = 'h-7 w-7' }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden>
      <g fill="none" strokeLinejoin="round" strokeLinecap="round">
        <circle cx="16" cy="15.2" r="9.4" stroke="#E8C547" strokeWidth="1.35" opacity="0.95" />
        <circle cx="16" cy="15.2" r="6.2" stroke="#3B8BE0" strokeWidth="1.15" opacity="0.55" />
        <path
          d="M16 3.4h4.4c.9 0 1.6.7 1.6 1.6v2.4c0 .9-.7 1.6-1.6 1.6h-1.5L17.2 11V9H16c-.9 0-1.6-.7-1.6-1.6V5c0-.9.7-1.6 1.6-1.6z"
          fill="#F7FBFF"
          stroke="#E8C547"
          strokeWidth="1.2"
        />
        <path
          d="M26.4 13.2v4.4c0 .9-.7 1.6-1.6 1.6h-2.4c-.9 0-1.6-.7-1.6-1.6v-1.5L19 18.8h2.2c.9 0 1.6-.7 1.6-1.6v-4c0-.9.7-1.6 1.6-1.6h.4c.9 0 1.6.7 1.6 1.6z"
          fill="#F7FBFF"
          stroke="#E8C547"
          strokeWidth="1.2"
        />
        <path
          d="M16 27.2h-4.4c-.9 0-1.6-.7-1.6-1.6v-2.4c0-.9.7-1.6 1.6-1.6h1.5L14.8 19.4V21.4H16c.9 0 1.6.7 1.6 1.6v2.6c0 .9-.7 1.6-1.6 1.6z"
          fill="#F7FBFF"
          stroke="#E8C547"
          strokeWidth="1.2"
        />
        <path
          d="M5.6 13.2v4.4c0 .9.7 1.6 1.6 1.6h2.4c.9 0 1.6-.7 1.6-1.6v-1.5L13 18.8h-2.2c-.9 0-1.6-.7-1.6-1.6v-4c0-.9-.7-1.6-1.6-1.6h-.4c-.9 0-1.6.7-1.6 1.6z"
          fill="#F7FBFF"
          stroke="#E8C547"
          strokeWidth="1.2"
        />
      </g>
    </svg>
  );
}
