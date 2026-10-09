// iOS builds no launch screen from the manifest. A home-screen app shows the startup
// image whose media query matches its screen exactly, else a blank one. A new screen
// size needs a row here, then `yarn pwa:assets` to render its images.

// Portrait CSS size and pixel ratio of every screen that runs iOS 16.4 or later.
const SCREENS = [
	{ width: 375, height: 667, ratio: 2 }, // iPhone 8, SE 2nd and 3rd gen
	{ width: 414, height: 736, ratio: 3 }, // iPhone 8 Plus
	{ width: 375, height: 812, ratio: 3 }, // iPhone X, XS, 11 Pro, 12 mini, 13 mini
	{ width: 414, height: 896, ratio: 2 }, // iPhone XR, 11
	{ width: 414, height: 896, ratio: 3 }, // iPhone XS Max, 11 Pro Max
	{ width: 390, height: 844, ratio: 3 }, // iPhone 12, 13, 14, 16e
	{ width: 428, height: 926, ratio: 3 }, // iPhone 12 Pro Max, 13 Pro Max, 14 Plus
	{ width: 393, height: 852, ratio: 3 }, // iPhone 14 Pro, 15, 15 Pro, 16
	{ width: 430, height: 932, ratio: 3 }, // iPhone 14 Pro Max, 15 Plus, 15 Pro Max, 16 Plus
	{ width: 402, height: 874, ratio: 3 }, // iPhone 16 Pro, 17, 17 Pro, 18 Pro
	{ width: 420, height: 912, ratio: 3 }, // iPhone Air
	{ width: 440, height: 956, ratio: 3 }, // iPhone 16 Pro Max, 17 Pro Max, 18 Pro Max
	{ width: 768, height: 1024, ratio: 2 }, // iPad 5th and 6th gen, mini 5, 9.7" Pro
	{ width: 744, height: 1133, ratio: 2 }, // iPad mini 6, mini A17 Pro
	{ width: 810, height: 1080, ratio: 2 }, // iPad 7th to 9th gen
	{ width: 820, height: 1180, ratio: 2 }, // iPad 10th gen, A16, Air 11"
	{ width: 834, height: 1112, ratio: 2 }, // iPad Air 3, 10.5" Pro
	{ width: 834, height: 1194, ratio: 2 }, // iPad Pro 11" 1st to 4th gen
	{ width: 834, height: 1210, ratio: 2 }, // iPad Pro 11" M4, M5
	{ width: 1024, height: 1366, ratio: 2 }, // iPad Pro 12.9", Air 13"
	{ width: 1032, height: 1376, ratio: 2 } // iPad Pro 13" M4, M5
];

export type Splash = {
	href: string;
	media: string;
	/** CSS size in this orientation. The image is this times `ratio` in pixels. */
	width: number;
	height: number;
	ratio: number;
	scheme: 'light' | 'dark';
};

export const splashScreens: Splash[] = SCREENS.flatMap(({ width, height, ratio }) =>
	(['portrait', 'landscape'] as const).flatMap((orientation) =>
		(['light', 'dark'] as const).map((scheme) => {
			const [w, h] = orientation === 'portrait' ? [width, height] : [height, width];
			return {
				href: `/splash/${w * ratio}x${h * ratio}-${scheme}.png`,
				// device-width and device-height stay the portrait values in either orientation.
				media:
					`(device-width: ${width}px) and (device-height: ${height}px) and ` +
					`(-webkit-device-pixel-ratio: ${ratio}) and (orientation: ${orientation}) and ` +
					`(prefers-color-scheme: ${scheme})`,
				width: w,
				height: h,
				ratio,
				scheme
			};
		})
	)
);
