const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

// Initialize Supabase
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

async function logToSheet(data, quoteSummary) {
    try {
        const rowData = {
            recipient: data.recipient,
            state: data.state,
            age: data.age,
            gender: data.gender,
            face_amount: data.faceAmount,
            product: data.product,
            mode: data.mode,
            quote_result: quoteSummary,
            // --- NEW FIELDS ---
            table_rating: data.tableRating || 'None',
            flat_extra: data.flatExtra || 0
        };

        const { error } = await supabase
            .from('leads')
            .insert([rowData]);

        if (error) throw error;
        console.log("📝 Lead saved to Supabase.");
        return true;

    } catch (error) {
        console.error("❌ Supabase Log Error:", error.message);
        return false;
    }
}

module.exports = { logToSheet };