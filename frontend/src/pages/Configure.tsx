/**
 * Instructor configuration page.
 * URL: /configure?token=<JWT>&game_instance_id=<uuid>
 *
 * Called from the classroom when an instructor adds or edits a Grays.com
 * session item. Reads the JWT to identify the instructor and game_instance_id,
 * shows the configuration form, and on save POSTs the game_config_id back
 * to the classroom callback URL.
 */
export default function Configure() {
  return (
    <main style={{ padding: '2rem', maxWidth: '800px', margin: '0 auto' }}>
      <h1>Configure Grays.com</h1>
      <p>Configuration UI not yet implemented.</p>
    </main>
  )
}
