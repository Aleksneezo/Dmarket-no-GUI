// CS2 Float Category Tiers & Wear Configurations

const WEAR_CONFIGS = {
    "Factory New": {
        short: "FN",
        dmarket_exterior: "factory new",
        total_range: [0.00, 0.07],
        tiers: [0.01, 0.02, 0.03, 0.07]
    },
    "Minimal Wear": {
        short: "MW",
        dmarket_exterior: "minimal wear",
        total_range: [0.07, 0.15],
        tiers: [0.08, 0.09, 0.10, 0.11, 0.15]
    },
    "Field-Tested": {
        short: "FT",
        dmarket_exterior: "field-tested",
        total_range: [0.15, 0.38],
        tiers: [0.18, 0.21, 0.24, 0.27, 0.38]
    },
    "Well-Worn": {
        short: "WW",
        dmarket_exterior: "well-worn",
        total_range: [0.38, 0.45],
        tiers: [0.4, 0.45]
    },
    "Battle-Scarred": {
        short: "BS",
        dmarket_exterior: "battle-scarred",
        total_range: [0.45, 1.00],
        tiers: [0.50, 0.63, 1.00]
    }
};

function detectWearFromTitle(title) {
    if (!title) return ["", "Field-Tested"];

    for (const [wearName, cfg] of Object.entries(WEAR_CONFIGS)) {
        const escaped = wearName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const reg = new RegExp(`\\s*\\(${escaped}\\)\\s*$`, 'i');
        if (reg.test(title)) {
            const cleanTitle = title.replace(reg, '').trim();
            return [cleanTitle, wearName];
        }
    }

    for (const [wearName, cfg] of Object.entries(WEAR_CONFIGS)) {
        if (title.includes(`(${cfg.short})`)) {
            const cleanTitle = title.replace(`(${cfg.short})`, '').trim();
            return [cleanTitle, wearName];
        }
    }

    return [title, "Field-Tested"];
}

function getFloatCategory(titleOrWear, floatVal) {
    let wearName = "Field-Tested";
    if (WEAR_CONFIGS[titleOrWear]) {
        wearName = titleOrWear;
    } else {
        const [, detected] = detectWearFromTitle(titleOrWear);
        wearName = detected;
    }

    const cfg = WEAR_CONFIGS[wearName] || WEAR_CONFIGS["Field-Tested"];
    const minWear = cfg.total_range[0];
    const maxWear = cfg.total_range[1];
    const tiers = cfg.tiers || [maxWear];

    let selectedUpper = maxWear;
    let selectedLower = minWear;
    let partIndex = tiers.length > 0 ? tiers.length - 1 : 0;
    if (floatVal !== null && floatVal !== undefined && !isNaN(floatVal)) {
        for (let i = 0; i < tiers.length; i++) {
            const tMax = tiers[i];
            if (floatVal <= (tMax + 1e-6)) {
                selectedUpper = tMax;
                selectedLower = minWear; // Always use bottom of wear quality
                partIndex = i;
                break;
            }
        }
    }

    const label = `${selectedLower.toFixed(2)} - ${selectedUpper.toFixed(2)}`;
    const floatPartValue = `${cfg.short}-${partIndex}`;

    return {
        wearName: wearName,
        wearShort: cfg.short,
        dmarket_exterior: cfg.dmarket_exterior,
        catLabel: label,
        label: label,
        minF: selectedLower,
        maxF: selectedUpper,
        min: selectedLower,
        max: selectedUpper,
        qualityMin: minWear,
        floatPartValue: floatPartValue
    };
}

export { WEAR_CONFIGS, getFloatCategory };
