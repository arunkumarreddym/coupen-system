const express = require("express");
const app = express();

app.use(express.json());

// In-memory storage for coupons
let coupons = [];

// Track coupon usage per user: { [userId]: { [couponCode]: count } }
let usageByUser = {};

/**
 * Helper: calculate total cart value
 */
function calculateCartValue(cart) {
    if (!cart || !Array.isArray(cart.items)) return 0;
    return cart.items.reduce((sum, item) => {
        const price = item.unitPrice || 0;
        const qty = item.quantity || 0;
        return sum + price * qty;
    }, 0);
}

/**
 * Helper: calculate total item count in cart
 */
function calculateItemsCount(cart) {
    if (!cart || !Array.isArray(cart.items)) return 0;
    return cart.items.reduce((sum, item) => {
        const qty = item.quantity || 0;
        return sum + qty;
    }, 0);
}

/**
 * Helper: check if coupon is within validity dates
 */
function isWithinDateRange(coupon, now) {
    const start = coupon.startDate ? new Date(coupon.startDate) : null;
    const end = coupon.endDate ? new Date(coupon.endDate) : null;

    if (start && now < start) return false;
    if (end && now > end) return false;

    return true;
}

/**
 * Helper: check usage limit per user
 */
function hasUsageLeft(coupon, userId) {
    if (!coupon.usageLimitPerUser) return true; // no limit

    const userUsage = usageByUser[userId] || {};
    const usedCount = userUsage[coupon.code] || 0;

    return usedCount < coupon.usageLimitPerUser;
}

/**
 * Helper: check eligibility rules (user + cart)
 */
function isCouponEligible(coupon, user, cart, cartValue) {
    const e = coupon.eligibility || {};
    const items = cart.items || [];

    // --- User-based rules ---

    // allowedUserTiers
    if (e.allowedUserTiers && e.allowedUserTiers.length > 0) {
        if (!e.allowedUserTiers.includes(user.userTier)) {
            return false;
        }
    }

    // minLifetimeSpend
    if (typeof e.minLifetimeSpend === "number") {
        if ((user.lifetimeSpend || 0) < e.minLifetimeSpend) {
            return false;
        }
    }

    // minOrdersPlaced
    if (typeof e.minOrdersPlaced === "number") {
        if ((user.ordersPlaced || 0) < e.minOrdersPlaced) {
            return false;
        }
    }

    // firstOrderOnly
    if (e.firstOrderOnly === true) {
        if ((user.ordersPlaced || 0) > 0) {
            return false;
        }
    }

    // allowedCountries
    if (e.allowedCountries && e.allowedCountries.length > 0) {
        if (!e.allowedCountries.includes(user.country)) {
            return false;
        }
    }

    // --- Cart-based rules ---

    // minCartValue
    if (typeof e.minCartValue === "number") {
        if (cartValue < e.minCartValue) {
            return false;
        }
    }

    // applicableCategories: at least one item must be in these categories
    if (e.applicableCategories && e.applicableCategories.length > 0) {
        const hasApplicable = items.some(item =>
            e.applicableCategories.includes(item.category)
        );
        if (!hasApplicable) {
            return false;
        }
    }

    // excludedCategories: none of the items must be in these categories
    if (e.excludedCategories && e.excludedCategories.length > 0) {
        const hasExcluded = items.some(item =>
            e.excludedCategories.includes(item.category)
        );
        if (hasExcluded) {
            return false;
        }
    }

    // minItemsCount: total quantity in cart
    if (typeof e.minItemsCount === "number") {
        const totalItems = calculateItemsCount(cart);
        if (totalItems < e.minItemsCount) {
            return false;
        }
    }

    return true;
}

/**
 * Helper: compute discount amount for a coupon
 */
function computeDiscount(coupon, cartValue) {
    if (cartValue <= 0) return 0;

    let discount = 0;

    if (coupon.discountType === "FLAT") {
        discount = coupon.discountValue || 0;
    } else if (coupon.discountType === "PERCENT") {
        const percent = coupon.discountValue || 0;
        discount = (percent / 100) * cartValue;

        if (coupon.maxDiscountAmount != null) {
            discount = Math.min(discount, coupon.maxDiscountAmount);
        }
    }

    // avoid discount more than cart value
    if (discount > cartValue) {
        discount = cartValue;
    }

    return discount;
}

/**
 * Root route - just to confirm server is running
 */
app.get("/", (req, res) => {
    res.send("Coupon Management System is running!");
});

/**
 * Create Coupon API
 * Method: POST
 * URL: /coupons
 */
app.post("/coupons", (req, res) => {
    const coupon = req.body;

    // Basic validation
    if (!coupon.code) {
        return res.status(400).json({ error: "Coupon 'code' is required" });
    }

    // Ensure unique code
    const existing = coupons.find(c => c.code === coupon.code);
    if (existing) {
        return res.status(400).json({ error: "Coupon code already exists" });
    }

    coupons.push(coupon);

    console.log("Current coupons:", coupons);

    return res.status(201).json({
        message: "Coupon created successfully",
        coupon: coupon,
    });
});

/**
 * List all coupons (for debugging)
 * Method: GET
 * URL: /coupons
 */
app.get("/coupons", (req, res) => {
    res.json(coupons);
});

/**
 * Best Coupon API
 * Method: POST
 * URL: /best-coupon
 * Body: { user: {...}, cart: {...} }
 */
app.post("/best-coupon", (req, res) => {
    const { user, cart } = req.body;

    if (!user || !cart) {
        return res.status(400).json({ error: "Both 'user' and 'cart' are required in body" });
    }

    const now = new Date();
    const cartValue = calculateCartValue(cart);

    let bestCoupon = null;
    let bestDiscount = 0;

    for (const coupon of coupons) {
        // 1. Date validity
        if (!isWithinDateRange(coupon, now)) continue;

        // 2. Usage limit
        if (!hasUsageLeft(coupon, user.userId)) continue;

        // 3. Eligibility rules
        if (!isCouponEligible(coupon, user, cart, cartValue)) continue;

        // 4. Discount calculation
        const discount = computeDiscount(coupon, cartValue);
        if (discount <= 0) continue;

        if (!bestCoupon) {
            bestCoupon = coupon;
            bestDiscount = discount;
        } else {
            // Tie-breaking rules:
            // 1) Higher discount
            // 2) If tie, earlier endDate
            // 3) If still tie, lexicographically smaller code
            if (discount > bestDiscount) {
                bestCoupon = coupon;
                bestDiscount = discount;
            } else if (discount === bestDiscount) {
                const currentEnd = coupon.endDate ? new Date(coupon.endDate) : null;
                const bestEnd = bestCoupon.endDate ? new Date(bestCoupon.endDate) : null;

                let chooseCurrent = false;

                if (currentEnd && bestEnd) {
                    if (currentEnd < bestEnd) {
                        chooseCurrent = true;
                    } else if (currentEnd.getTime() === bestEnd.getTime()) {
                        if (coupon.code < bestCoupon.code) {
                            chooseCurrent = true;
                        }
                    }
                } else if (currentEnd && !bestEnd) {
                    // Prefer coupon with an end date
                    chooseCurrent = true;
                } else if (!currentEnd && !bestEnd) {
                    if (coupon.code < bestCoupon.code) {
                        chooseCurrent = true;
                    }
                }

                if (chooseCurrent) {
                    bestCoupon = coupon;
                    bestDiscount = discount;
                }
            }
        }
    }

    if (!bestCoupon) {
        return res.json({
            bestCoupon: null,
            discountAmount: 0,
            cartValue: cartValue
        });
    }

    // Increase usage count for this user & coupon
    if (!usageByUser[user.userId]) {
        usageByUser[user.userId] = {};
    }
    const userUsage = usageByUser[user.userId];
    userUsage[bestCoupon.code] = (userUsage[bestCoupon.code] || 0) + 1;

    return res.json({
        bestCoupon: {
            code: bestCoupon.code,
            description: bestCoupon.description,
            discountType: bestCoupon.discountType,
            discountValue: bestCoupon.discountValue,
            discountAmount: bestDiscount
        },
        cartValue: cartValue,
        message: "Best coupon selected successfully"
    });
});

// Start server
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
