-- Migration 007: Web auth support
-- Adds auth_user_id to profiles for Supabase Auth linking
-- Adds link_code for Telegram account linking

-- Link profiles to Supabase Auth users
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS auth_user_id UUID UNIQUE;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS link_code TEXT;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS link_code_expires TIMESTAMPTZ;

-- Index for fast auth lookups
CREATE INDEX IF NOT EXISTS idx_profiles_auth_user_id ON profiles (auth_user_id) WHERE auth_user_id IS NOT NULL;

-- Auto-create profile + wallet when a new Supabase Auth user signs up
CREATE OR REPLACE FUNCTION handle_new_auth_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO profiles (auth_user_id, first_name, username)
  VALUES (NEW.id, COALESCE(NEW.raw_user_meta_data->>'full_name', split_part(NEW.email, '@', 1)), NEW.email)
  ON CONFLICT (auth_user_id) DO NOTHING;

  -- Create wallet for the new user
  INSERT INTO wallets (user_id, balance_cents)
  SELECT id, 0 FROM profiles WHERE auth_user_id = NEW.id
  ON CONFLICT (user_id) DO NOTHING;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Drop trigger if exists then create
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION handle_new_auth_user();

-- RLS policies for anon key access (website frontend)
-- Profiles: users can read their own profile
CREATE POLICY IF NOT EXISTS "Users read own profile"
  ON profiles FOR SELECT
  USING (auth_user_id = auth.uid());

-- Wallets: users can read their own wallet
CREATE POLICY IF NOT EXISTS "Users read own wallet"
  ON wallets FOR SELECT
  USING (user_id IN (SELECT id FROM profiles WHERE auth_user_id = auth.uid()));

-- Orders: users can read their own orders
CREATE POLICY IF NOT EXISTS "Users read own orders"
  ON orders FOR SELECT
  USING (user_id IN (SELECT id FROM profiles WHERE auth_user_id = auth.uid()));
