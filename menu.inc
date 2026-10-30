<?php
# One entry per menu area (PLUGIN_GUIDELINES 9.1): the leveler page under
# Content Setup, and a single help page.
$menuEntries = Array(
	Array(
		'text' => 'Audio Leveler',
		'type' => 'content',
		'page' => 'content.php',
		'wrap' => 1
	),
	Array(
		'text' => 'Audio Leveler - Help',
		'type' => 'help',
		'page' => 'about.php',
		'wrap' => 1
	)
);

foreach ($menuEntries as $entry)
{
	if ($entry['type'] != $menu)
		continue;

	$nopage = '';
	if (isset($entry['wrap']) && ($entry['wrap'] == 0))
		$nopage = '&nopage=1';

	printf("<li><a href='plugin.php?plugin=%s&page=%s%s'>%s</a></li>\n",
		$plugin, $entry['page'], $nopage, $entry['text']);
}
?>
