import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = 'https://gzkbaphfgtgvhbjhoxqa.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imd6a2JhcGhmZ3RndmhiamhveHFhIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4MzY1NzYwNiwiZXhwIjoyMDk5MjMzNjA2fQ._TBx0xSfo4pud7lmk7vfYgWMWmr2bX3CPxrQyvCyX8E';

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

async function run() {
    // Check if tables exist by trying a simple query
    const { data, error } = await supabase
        .from('activation_codes')
        .select('code')
        .limit(1);
    
    if (error) {
        console.log('Tables not ready:', error.message);
        console.log('Need to create tables via SQL Editor.');
        process.exit(1);
    } else {
        console.log('Tables exist! Data:', JSON.stringify(data));
    }
    
    console.log('Supabase connection verified successfully!');
}

run().catch(console.error);
