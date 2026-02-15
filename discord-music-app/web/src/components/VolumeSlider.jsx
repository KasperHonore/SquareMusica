export function VolumeSlider({ value, onChange }) {
  return (
    <div className="bg-gray-800 p-4 rounded-lg">
      <div className="flex items-center gap-4">
        <span className="text-gray-400">🔊</span>
        <input
          type="range"
          min="0"
          max="100"
          value={value}
          onChange={(e) => onChange(parseInt(e.target.value))}
          className="flex-1 h-2 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-green-500"
          aria-label="Volume"
        />
        <span className="text-gray-400 w-12 text-right">{value}%</span>
      </div>
    </div>
  );
}
