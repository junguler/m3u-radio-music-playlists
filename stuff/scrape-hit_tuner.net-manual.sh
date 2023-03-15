#!/bin/bash

# find genres, languages, countries and states of the usa
curl http://www.hit-tuner.net/en/genre/index.html | htmlq -a href a | grep "worldwide/genre" | cut -c20- | rev | cut -c6- | rev > genres.txt
curl http://www.hit-tuner.net/en/worldwide/index.html | htmlq -a href a | grep "language" | awk '!seen[$0]++' | cut -c10- | rev | cut -c6- | rev > languages.txt
for i in "asia" "europe" "middle_east" "africa" "northamerica" "caribbean" "southamerica" "oceania" ; do curl http://www.hit-tuner.net/en/worldwide/$i.html | htmlq -a href a | grep "country" | cut -c9- | rev | cut -c6- | rev | awk '!seen[$0]++' >> countries.txt ; done

# find the pages for each stream, scrape the genre files 
for j in $(cat genres.txt) ; do curl -s http://www.hit-tuner.net/en/worldwide/genre/$j.html | htmlq -a href a | grep "worldwide/radio" | cut -c23- >> A-$j.txt ; done
for i in {2..5} ; do for j in $(cat genres.txt) ; do curl -s http://www.hit-tuner.net/en/worldwide/genre/index.php\?seite\=$i\&suchwort\=$j\&auswahl\=\&db\= | htmlq -a href a | grep "worldwide/radio" | cut -c23- >> A-$j.txt ; echo -e "$i - $j" ; done ; done

# scrape the language files 
for j in $(cat languages.txt) ; do curl -s http://www.hit-tuner.net/en/worldwide/language/$j.html | htmlq -a href a | grep "../radio" | cut -c10- >> A-$j.txt ; done
for i in {2..12} ; do for j in $(cat languages.txt) ; do curl -s http://www.hit-tuner.net/en/worldwide/language/index.php\?seite\=$i\&genre\=$j | htmlq -a href a | grep "../radio" | cut -c10- >> A-$j.txt ; echo -e "$i - $j" ; done ; done

# scrape the country files 
for j in $(cat countries.txt) ; do curl -s http://www.hit-tuner.net/en/worldwide/country/$j.html | htmlq -a href a | grep "../radio" | cut -c10-  >> A-$j.txt ; done
for i in {2..32} ; do for j in $(cat countries.txt) ; do curl -s http://www.hit-tuner.net/en/worldwide/country/index.php\?seite\=$i\&genre\=$j | htmlq -a href a | grep "../radio" | cut -c10- >> A-$j.txt ; echo -e "$i - $j" ; done ; done

# scrape links 
for i in A-*.txt ; do for j in $(cat $i) ; do curl -s http://www.hit-tuner.net/en/worldwide/radio/$j | grep "\"name\":\"" | awk -F '"' '{print $4}' | sed 's/\;//g' | sed '/^$/d' >> A$i ; echo -e "$i - $j" ; done ; done 

# convert links to m3u streams
for i in AA-*.txt ; do sed "s/^/#EXTINF:-1\n/" $i | sed '1s/^/#EXTM3U\n/' > $i.m3u ; done

# remove AA- and double extensions in streams
for i in *.m3u ; do mv "$i" "`echo $i | sed -e 's/AA-//' -e 's/.txt//'`" ; done

# remove %2B and _music strings from the stream file names
for i in *.m3u ; do mv -- "$i" "$(printf '%s\n' "$i" | sed 's/%2B/_/')" ; done
for i in *.m3u ; do mv -- "$i" "$(printf '%s\n' "$i" | sed 's/_music//')" ; done

# remove temp and empty files 
rm genres.txt languages.txt countries.txt
find . -type f -empty -delete

# move stream to git folder
mv *.m3u c:/git/m3u-radio-music-playlists/hit_tuner.net/

# add, commit and push
git -C c:/git/m3u-radio-music-playlists/ add .
git -C c:/git/m3u-radio-music-playlists/ commit -m "`date +'%b/%d - %I:%M %p'`"
git -C c:/git/m3u-radio-music-playlists/ push
