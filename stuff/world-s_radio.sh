# get the list of everything from the sitemap
for i in {0..2} ; do curl -s https://www.worldsradio.com/sitemap/$i.xml > $1.xml ; done
cat *.xml | htmlq loc -t > links.txt 

# get the list of countries, genres, languages and uncategorized stations
curl -s https://www.worldsradio.com/ | sed -E 's#<li>#\n<li>#g; s#</li>#</li>\n#g' | sed -nE 's#.*href="/country/([^"]+)">([^<]+)<span[^>]*>.*#\1___\2#p' | tr ' ' '_' > countries.txt 
cat links.txt | grep '/genre/' | awk -F '/' '{print $NF}' > genres.txt
cat links.txt | grep '/language/' | awk -F '/' '{print $NF}' > languages.txt
cat links.txt | grep '/stations/' | awk -F '/' '{print $NF}' > stations.txt

# get the ids from each category
for i in $(cat countries.txt) ; do curl -s https://www.worldsradio.com/country/$(echo $i | awk -F '___' '{print $1}') | htmlq -a href a | grep '/stations/' | awk -F '/' '{print $NF}' > A-$(echo $i | awk -F '___' '{print $2}').txt ; done
for i in $(cat genres.txt) ; do curl -s https://www.worldsradio.com/genre/$i | htmlq -a href a | grep '/stations/' | awk -F '/' '{print $NF}' > A-$i.txt ; done
for i in $(cat languages.txt) ; do curl -s https://www.worldsradio.com/language/$i | htmlq -a href a | grep '/stations/' | awk -F '/' '{print $NF}' > A-$i.txt ; done

# scrape everything
for i in A-*.txt ; do out="${i#A-}" ; out="${out%.txt}.m3u" ; : > "$out" ; while IFS= read -r j ; do echo -e "$i - $j" ; u="https://www.worldsradio.com/stations/$j" ; t=$(curl -s "$u" | htmlq -t h1 | tr '\n' ' ' | sed 's/[[:space:]]\+/ /g ; s/^ *// ; s/ *$//') ; s=$(curl -s "$u" | tr -d '\\' | grep -o '"url":"[^"]*' | cut -d '"' -f4 | sed -n '13p') ; [ -n "$t" ] && [ -n "$s" ] && printf '#EXTINF:-1,%s\n%s\n' "$t" "$s" >> "$out" ; done < "$i" ; done